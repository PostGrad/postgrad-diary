---
title: "Migrating staging off Docker, and the database I forgot to restore"
description: "Moving a staging environment from docker-compose to the same pm2 + native Postgres setup as production, and the login outage that taught us a restored dump isn't the whole database"
pubDate: 2026-09-28
tags:
  - devops
  - postgres
  - keycloak
  - docker
  - pm2
  - migration
draft: false
---

We run three environments: local dev, staging, and production. Production has always been simple. pm2 manages the backend and frontend processes directly on the host, and a managed Postgres instance holds the data. Staging had drifted from that: two servers, everything in docker-compose (backend, database, Keycloak, nginx, even a redis service that wasn't actually running). Local dev looked more like production than staging did, which is backwards, and it meant bugs that only show up in a specific process-management setup could hide until they hit staging's very different container topology, or worse, until production.

So we moved staging to match production: pm2 for the backend and frontend, a native Postgres install instead of a container, and only Keycloak left containerized (there was no equivalent local Keycloak setup worth replicating, and it wasn't the thing we were trying to align). This post is about that migration, and specifically about the one mistake in it that took staging's login down for a few minutes. Not because the migration was wrong, but because "restore the database" turned out to mean two databases, not one.

## First: check the machine can actually take it

Before doing anything, we checked capacity on the box that would carry the extra load: 2 vCPUs, 3.8GB RAM, no swap. Tight but workable, except the load average sat at 1.3 to 1.9 on a 2-core machine that was otherwise supposedly idle. `top` showed why: a `bash` process, 100% CPU, elapsed time 49 days. Someone's SSH session had disconnected without the shell ever finding out. Its controlling terminal was gone (`/dev/pts/1 (deleted)`), so it was spinning in a tight loop trying to read from a pseudo-terminal that no longer existed, burning a full core the entire time. Killing it dropped the load average to 0.00 within a couple of minutes. That's an easy one to miss if you only ever check `docker stats`. The containers were innocent, the host wasn't.

## Native Postgres, then Keycloak, then pm2

The actual migration was three separate cutovers, done in sequence rather than all at once so each could be verified before the next started:

**Postgres**, installed natively via the PGDG apt repo to match the container's major version, configured to accept connections both from `localhost` and from the docker bridge network (Keycloak was staying in a container and needed to reach it):

```
host    all             all             127.0.0.1/32            scram-sha-256
host    all             all             172.19.0.0/16           scram-sha-256
```

**pm2**, replacing the `backend` and `nginx` services in docker-compose entirely. The backend became a plain `pm2 start index.js`, and we installed nginx directly on the host to do what the containerized nginx used to do: terminate TLS and reverse proxy, just now pointing at `127.0.0.1:4040` instead of a docker-network hostname.

**Keycloak** stayed exactly where it was, in docker-compose, just pointed at the new native database instead of the old containerized one.

None of this is exotic. The database swap, the process manager swap, the reverse proxy swap: each one individually is a well-trodden path. The mistake was in what came right after.

## The mistake: one dump, two databases

We had a production-scale SQL dump to restore into the new native Postgres, so the plan was: create the app's database, restore the dump into it, done. Which we did. Login broke immediately after.

The `identity` domain's Keycloak login started returning Keycloak's own generic branded 404, "We are sorry... Page not found," on the exact realm path our login flow redirects to. That's not a connection failure page. That's what Keycloak shows you when it's running fine, connected to a database fine, and that database simply has no realm by that name.

Which is exactly what had happened. Keycloak keeps its own database, separate from the application's database, holding the realm, the clients, every user's credentials and sessions. We'd created that database fresh and empty, and Keycloak did exactly what it's supposed to do with a brand-new empty database: initialize its own baseline schema and boot up as a fresh, empty instance. No error, no crash, just a real, working, entirely blank identity server. The application's dump had nothing to do with it. We'd simply never restored Keycloak's database at all, because "restore the dump" had quietly narrowed, in our own heads, to mean the one database we'd been thinking about.

The fix was straightforward once diagnosed: the old container's data volume hadn't been deleted (kept deliberately as a rollback path during the cutover), so we could spin up a disposable container against it, dump just the Keycloak database out of it, and restore that into the new native instance. The realm came back exactly as it was. But the outage itself was self-inflicted, and it's the kind of mistake that's obvious in hindsight and invisible in the moment: when a migration touches a database that backs more than one service, "restore the database" is really "restore every database," and it's very easy to only be thinking about the one your own application code talks to.

## Smaller gotchas along the way

A handful of other things only showed up by actually doing the migration, not by planning it:

**Two live compose files, only one of them real.** The deployed server had a `docker-compose.yml` at the project root and an identically-named, inactive duplicate sitting one directory down, left over from an earlier deployment layout. `docker inspect`'s own labels on the running containers pointed at the real one, but I edited the decoy first, made a change, watched nothing happen, and only then went looking for why. Worth checking `com.docker.compose.project.config_files` on a running container before assuming the compose file next to you is the one that made it.

**Vite's preview server rejects hosts it doesn't recognize.** Serving the frontend's production build with `vite preview` under pm2 worked perfectly over `localhost`, and returned a flat 403 the moment the same request came in through the reverse proxy with a real domain in the `Host` header. `vite preview` treats an unrecognized `Host` as a DNS-rebinding attempt by default and blocks it. Needed one line in `vite.config.js`:

```js
preview: {
  allowedHosts: ['your-staging-domain.example.com'],
},
```

**A restore doesn't restore the migrations that ran after it was taken.** The dump we restored predated about two weeks of schema changes and a data-correction script that had already been applied, and then quietly un-applied by the restore, without anyone telling it to. The fix wasn't dramatic: re-run everything file by file against a real reference database (we used local dev, since it had actually kept up), checking each one's expected effect before trusting it. But it's a reminder that a database restore is a point-in-time snapshot, not a merge. Anything that happened between "when the dump was taken" and "now" has to be replayed deliberately, it doesn't come along for free.

**A deploy script that assumed the server was never touched by hand.** Partway through, `git pull` on the server started failing with "local changes would be overwritten by merge," because the server's working copy had picked up direct edits somewhere along the way and never committed them. The actual fix was less about untangling that one incident and more about closing the door on it happening again. Since nobody is meant to edit code directly on a server, the deploy script now does `git fetch && git reset --hard origin/<branch> && git clean -fd` instead of `git pull`. Remote is unconditionally the source of truth, and any local drift just gets discarded on the next deploy rather than silently blocking it.

## What I'd do differently

Before restoring a dump into an environment, write down every distinct database a service in that environment owns, not just the one your own application queries, and restore each deliberately. "The database" is often plural the moment more than one service shares an environment, and the failure mode when you miss one isn't an error message, it's a system that boots cleanly and is simply wrong.

Keep the old data around during a cutover even after the new thing is verified working. It cost nothing to leave that volume in place, and it's exactly what made the recovery from the Keycloak incident a fifteen-minute fix instead of a much longer one.

And check the host, not just the containers, before trusting a capacity plan. A stuck process from a completely unrelated incident had been quietly eating half of a two-core budget for seven weeks, and every container-level metric looked fine the entire time.
