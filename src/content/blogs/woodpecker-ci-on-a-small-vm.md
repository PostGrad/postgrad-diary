---
title: "CI/CD on a 2 vCPU server, without buying anything"
description: "Setting up Woodpecker CI on a small shared VM: manual-only deploys to staging and production, a production key that can do five things, a fail-safe rollback button, and the small stuff that broke on the way"
pubDate: 2026-10-27
updatedDate: 2026-10-27
tags:
  - devops
  - ci-cd
  - woodpecker
  - pm2
  - self-hosted
  - rollback
draft: false
---

For a long time our deploys were a ritual. SSH into the server, run a script, watch the output, hope. That works fine while the person who knows the ritual is around. I wanted to go on leave without leaving a trail of "how do I deploy this" messages, so the goal was simple: a teammate clicks a button and the right thing happens, for staging and for production.

The constraints made it more interesting. No budget for a new server. Private repositories. A small team. And the only machine that could host the thing already had a job: it runs our staging backend, with 2 vCPUs and 3.8 GB of RAM.

## Why not the usual suspects

I looked at three options before settling.

| Option | What put me off |
|---|---|
| GitHub Actions | Minutes are metered on private repos. And the runners still have to reach our servers, either through inbound SSH from the internet or a self-hosted runner, which is the thing I was trying to avoid running. |
| Jenkins | A JVM that wants most of a gigabyte before it has built anything. On a 3.8 GB box that also serves an app, no. |
| Woodpecker CI | A single Go binary for the server and another for the agent, SQLite for storage. Small enough to forget about. |

Woodpecker won on one number. Idle, the server sits around 50 MB and the agent around 18 MB. I still capped both with systemd so a bad build can never take the staging app down with it.

<svg viewBox="0 0 660 236" role="img" aria-label="Bar charts: Woodpecker memory caps on a 3.8 GB machine versus its small idle usage" style="width:100%;height:auto;display:block;margin:1.5rem 0"><defs><marker id="ah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--text-muted)"/></marker></defs><text x="10" y="22" text-anchor="start" style="font-family:inherit;font-size:13px;font-weight:600;fill:var(--text)">RAM on the VM: 3.8 GB, and what Woodpecker is allowed to take</text><text x="10" y="56" text-anchor="start" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">Hard caps (systemd MemoryMax)</text><rect x="10" y="64" width="67.4" height="34" style="fill:var(--accent);opacity:.9"/><rect x="77.4" y="64" width="303.2" height="34" style="fill:var(--accent);opacity:.45"/><rect x="380.5" y="64" width="269.5" height="34" style="fill:var(--surface);stroke:var(--line);stroke-width:1.2"/><text x="228.94736842105266" y="86" text-anchor="middle" style="font-family:inherit;font-size:11px;font-weight:600;fill:var(--text)">agent 1.8 GB (builds spike)</text><text x="515.2631578947369" y="86" text-anchor="middle" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">staging app, OS, the rest</text><text x="10" y="114" text-anchor="start" style="font-family:inherit;font-size:10.5px;fill:var(--text-muted)">server 0.4 GB</text><text x="10" y="150" text-anchor="start" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">What they use while idle</text><rect x="10" y="158" width="8.4" height="34" style="fill:var(--accent)"/><rect x="20.4" y="158" width="3.0" height="34" style="fill:var(--accent);opacity:.5"/><rect x="10" y="158" width="640" height="34" style="fill:none;stroke:var(--line);stroke-width:1.2"/><text x="35.349267540478024" y="180" text-anchor="start" style="font-family:inherit;font-size:11px;fill:var(--text)">server about 50 MB, agent about 18 MB. Under 2% of the machine.</text><text x="10" y="220" text-anchor="start" style="font-family:inherit;font-size:10.5px;fill:var(--text-muted)">The agent cap is generous on purpose: npm ci and a frontend build are what actually use memory, and only while a deploy runs.</text></svg>

## The shape of it

Everything runs on that one VM as plain systemd services. No Docker for the CI itself. nginx terminates TLS in front of the Woodpecker UI, the server talks to the agent over localhost, and the agent is the part that actually does things.

<svg viewBox="0 0 720 365" role="img" aria-label="Architecture: browser to nginx to Woodpecker server and agent, which deploys to staging locally and to the frontend VM and production over locked ssh keys" style="width:100%;height:auto;display:block;margin:1.5rem 0"><defs><marker id="ah1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--text-muted)"/></marker></defs><rect x="125" y="8" width="585" height="200" rx="12" style="fill:none;stroke:var(--text-dim);stroke-width:1.3;stroke-dasharray:6 5"/><text x="137" y="28" text-anchor="start" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">One small CI VM (2 vCPU), shared with the staging backend</text><rect x="10" y="60" width="90" height="50" rx="8" style="fill:var(--surface);stroke:var(--line);stroke-width:1.4"/><text x="55.0" y="81.0" text-anchor="middle" style="font-family:inherit;font-size:13px;font-weight:600;fill:var(--text)">Teammate</text><text x="55.0" y="98.0" text-anchor="middle" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">browser</text><rect x="140" y="60" width="95" height="50" rx="8" style="fill:var(--surface);stroke:var(--line);stroke-width:1.4"/><text x="187.5" y="81.0" text-anchor="middle" style="font-family:inherit;font-size:13px;font-weight:600;fill:var(--text)">nginx</text><text x="187.5" y="98.0" text-anchor="middle" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">TLS</text><rect x="262" y="60" width="135" height="50" rx="8" style="fill:var(--surface);stroke:var(--line);stroke-width:1.4"/><text x="329.5" y="81.0" text-anchor="middle" style="font-family:inherit;font-size:13px;font-weight:600;fill:var(--text)">Woodpecker</text><text x="329.5" y="98.0" text-anchor="middle" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">server + SQLite</text><rect x="425" y="60" width="130" height="50" rx="8" style="fill:var(--surface);stroke:var(--line);stroke-width:1.4"/><text x="490.0" y="81.0" text-anchor="middle" style="font-family:inherit;font-size:13px;font-weight:600;fill:var(--text)">Agent</text><text x="490.0" y="98.0" text-anchor="middle" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">local backend</text><rect x="578" y="60" width="125" height="50" rx="8" style="fill:var(--surface);stroke:var(--line);stroke-width:1.4"/><text x="640.5" y="81.0" text-anchor="middle" style="font-family:inherit;font-size:13px;font-weight:600;fill:var(--text)">Staging API</text><text x="640.5" y="98.0" text-anchor="middle" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">pm2 on this VM</text><line x1="100" y1="85" x2="140" y2="85" style="stroke:var(--text-muted);stroke-width:1.5;" marker-end="url(#ah1)"/><text x="120" y="76" text-anchor="middle" style="font-family:inherit;font-size:10px;fill:var(--text-muted)">HTTPS</text><line x1="235" y1="85" x2="262" y2="85" style="stroke:var(--text-muted);stroke-width:1.5;" marker-end="url(#ah1)"/><line x1="397" y1="85" x2="425" y2="85" style="stroke:var(--text-muted);stroke-width:1.5;" marker-end="url(#ah1)"/><text x="411" y="128" text-anchor="middle" style="font-family:inherit;font-size:10px;fill:var(--text-muted)"></text><line x1="555" y1="85" x2="578" y2="85" style="stroke:var(--text-muted);stroke-width:1.5;" marker-end="url(#ah1)"/><text x="566" y="128" text-anchor="middle" style="font-family:inherit;font-size:10px;fill:var(--text-muted)"></text><text x="566" y="126" text-anchor="middle" style="font-family:inherit;font-size:10px;fill:var(--text-muted)">runs the</text><text x="566" y="139" text-anchor="middle" style="font-family:inherit;font-size:10px;fill:var(--text-muted)">script here</text><rect x="250" y="290" width="185" height="56" rx="8" style="fill:var(--surface);stroke:var(--line);stroke-width:1.4"/><text x="342.5" y="314.0" text-anchor="middle" style="font-family:inherit;font-size:13px;font-weight:600;fill:var(--text)">Staging frontend VM</text><text x="342.5" y="331.0" text-anchor="middle" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">ssh, key locked to 1 script</text><rect x="490" y="290" width="205" height="56" rx="8" style="fill:var(--surface);stroke:var(--accent);stroke-width:2.2"/><text x="592.5" y="314.0" text-anchor="middle" style="font-family:inherit;font-size:13px;font-weight:600;fill:var(--text)">Production host</text><text x="592.5" y="331.0" text-anchor="middle" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">ssh, 5 fixed actions only</text><line x1="465" y1="110" x2="360" y2="290" style="stroke:var(--text-muted);stroke-width:1.5;stroke-dasharray:5 4;" marker-end="url(#ah1)"/><line x1="515" y1="110" x2="590" y2="290" style="stroke:var(--text-muted);stroke-width:1.5;stroke-dasharray:5 4;" marker-end="url(#ah1)"/><text x="300" y="236" text-anchor="middle" style="font-family:inherit;font-size:10px;fill:var(--text-muted)">ssh out of the VM</text><text x="300" y="250" text-anchor="middle" style="font-family:inherit;font-size:10px;fill:var(--text-muted)">(the only way in is a locked key)</text><text x="10" y="46" text-anchor="middle" style="font-family:inherit;font-size:10px;fill:var(--text-muted)"></text></svg>

Staging backend deploys happen right there on the VM. Staging frontend and production live on other machines, so the agent reaches them over SSH. More on those keys in a minute, because they are the part I spent the most care on.

## Local backend, on purpose

Woodpecker normally runs every pipeline step inside a container. I switched that off and used the local backend, which runs each step directly on the host as a normal user.

Why: the deploy step needs to reload a pm2 process that already lives on that machine. Running a container for that means running a Docker daemon on a box with no room to spare, then punching holes back out of the container to reach the thing I wanted to touch.

It is not free, though. The trade is plain:

| | Local backend | Container backend |
|---|---|---|
| Extra RAM | none | a Docker daemon plus the images |
| Reaching pm2 and app folders | direct | needs mounts and tricks |
| Isolation | none | real |
| Someone edits a workflow | they get a shell as the CI user | they get a container |

That last row is the honest cost, and I come back to it near the end.

## Manual only, by design

I did not want pushes or merges to deploy anything. A deploy should be a decision. So every pipeline is limited to the manual event, and a person starts it with the Run pipeline button:

```yaml
when:
  - event: manual
    branch: staging

skip_clone: true

steps:
  - name: deploy-staging
    image: bash
    commands:
      - /home/deploy/ci/deploy-backend.sh staging
```

A few notes on this tiny file. `skip_clone` is there because the script works inside the app's own checkout, so there is nothing to clone. `image` is required by the schema but ignored by the local backend. And Woodpecker reads the workflow from the branch you run, so the file has to be merged to that branch before the button does anything. I lost a bit of time wondering why a pipeline did not show up before I remembered that.

## The scripts own the logic, not the CI

This is the decision I would repeat on any project. The pipeline does one thing: it calls a script. The scripts are the same ones people can run by hand over SSH. If Woodpecker is down, or I pull it out in a year, deploys still work.

The backend script goes in a careful order: update the code, install dependencies only if the lockfile changed, back up the database and run any pending migrations, and only then reload the app and wait for a health check. If anything fails before the reload, the running version is never touched.

<svg viewBox="0 0 580 238" role="img" aria-label="Stacked bar showing the time of each step in a production backend deploy" style="width:100%;height:auto;display:block;margin:1.5rem 0"><defs><marker id="ah3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--text-muted)"/></marker></defs><text x="10" y="22" text-anchor="start" style="font-family:inherit;font-size:13px;font-weight:600;fill:var(--text)">A real production backend deploy, about 18 seconds</text><rect x="10" y="38" width="64" height="38" style="fill:var(--accent);opacity:0.35;stroke:var(--bg);stroke-width:2"/><text x="42.0" y="62" text-anchor="middle" style="font-family:inherit;font-size:12px;font-weight:600;fill:var(--text)">1</text><rect x="74" y="38" width="32" height="38" style="fill:var(--accent);opacity:0.55;stroke:var(--bg);stroke-width:2"/><text x="90.0" y="62" text-anchor="middle" style="font-family:inherit;font-size:12px;font-weight:600;fill:var(--text)">2</text><rect x="106" y="38" width="256" height="38" style="fill:var(--accent);opacity:0.9;stroke:var(--bg);stroke-width:2"/><text x="234.0" y="62" text-anchor="middle" style="font-family:inherit;font-size:12px;font-weight:600;fill:var(--text)">3</text><rect x="362" y="38" width="32" height="38" style="fill:var(--accent);opacity:0.55;stroke:var(--bg);stroke-width:2"/><text x="378.0" y="62" text-anchor="middle" style="font-family:inherit;font-size:12px;font-weight:600;fill:var(--text)">4</text><rect x="394" y="38" width="192" height="38" style="fill:var(--accent);opacity:0.75;stroke:var(--bg);stroke-width:2"/><text x="490.0" y="62" text-anchor="middle" style="font-family:inherit;font-size:12px;font-weight:600;fill:var(--text)">5</text><text x="10" y="112" text-anchor="start" style="font-family:inherit;font-size:12px;fill:var(--text)">1  Preflight check: 2s</text><text x="10" y="132" text-anchor="start" style="font-family:inherit;font-size:12px;fill:var(--text)">2  Update code: 1s</text><text x="10" y="152" text-anchor="start" style="font-family:inherit;font-size:12px;fill:var(--text)">3  npm ci: 8s</text><text x="10" y="172" text-anchor="start" style="font-family:inherit;font-size:12px;fill:var(--text)">4  Migrations: 1s</text><text x="10" y="192" text-anchor="start" style="font-family:inherit;font-size:12px;fill:var(--text)">5  Restart + health wait: 6s</text><text x="10" y="216" text-anchor="start" style="font-family:inherit;font-size:10.5px;fill:var(--text-muted)">Migrations run before the restart. If any step before 5 fails, the old version keeps serving.</text></svg>

## Production: a key that can do five things

Staging is forgiving. Production is not, and the CI box is a shared machine, so I did not want a key on it that could do arbitrary things to production.

The answer is an SSH key locked to a forced command. In the server's `authorized_keys` it looks like this:

```
restrict,from="<ci-box-ip>",command="/usr/local/bin/ci-wrapper" ssh-ed25519 AAAA... ci-prod
```

`restrict` turns off shells, forwarding and the rest. `from` limits it to the CI box. And `command` means whatever the client asks for, the server runs the wrapper instead, which only understands five words:

```bash
case "${SSH_ORIGINAL_COMMAND:-}" in
  backend-check)     exec sudo -n /bin/bash /opt/deploy/backend.sh --check ;;
  backend-deploy)    exec sudo -n /bin/bash /opt/deploy/backend.sh ;;
  frontend-check)    exec sudo -n /bin/bash /opt/deploy/frontend.sh --check ;;
  frontend-deploy)   exec sudo -n /bin/bash /opt/deploy/frontend.sh ;;
  frontend-rollback) exec sudo -n /bin/bash /opt/deploy/frontend.sh --rollback ;;
  *) echo "not allowed: ${SSH_ORIGINAL_COMMAND:-<none>}" >&2; exit 2 ;;
esac
```

I tested it by asking for `id`. The answer was `not allowed: id`. Even if that key leaks, the worst anyone can do with it is run a check or a deploy, which is what it is for.

The private half lives as a Woodpecker secret limited to manual events. Every production pipeline runs the check mode first, then the real deploy, so a bad state (no disk space, wrong branch) stops it before anything changes.

## Rollback: a separate button, on purpose

Deploying is the easy half. The first thing a teammate will ask is what happens when a deploy goes wrong, so the setup needs an undo too.

The obvious way is a second workflow that also runs when someone clicks Run pipeline. That does not work: both workflows match the click, so one button starts a deploy and a rollback at the same time. Woodpecker has a different event for this, `deployment`. You trigger it from a finished, green pipeline with a Deploy button, and it asks for a target environment. The rollback workflow only matches that event with one specific target:

```yaml
when:
  - event: deployment
    branch: staging
    evaluate: 'CI_PIPELINE_DEPLOY_TARGET == "rollback"'
```

A nice side effect is that it fails safe. Type `rollbak` and nothing happens. If I had used a variable on the normal Run pipeline dialog instead, a typo would quietly run a plain deploy, which is the opposite of what you want at the moment you are rolling back. You also have to switch on "Allow Deployments" per repository first, so nothing changes until you decide it should.

<svg viewBox="0 0 740 200" role="img" aria-label="Rollback flow: green pipeline, Deploy with target rollback, preview, rollback, health wait; a typo in the target runs nothing" style="width:100%;height:auto;display:block;margin:1.5rem 0"><defs><marker id="ah4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" style="fill:var(--text-muted)"/></marker></defs><rect x="10" y="30" width="128" height="58" rx="8" style="fill:var(--surface);stroke:var(--line);stroke-width:1.4;"/><text x="74.0" y="56.0" text-anchor="middle" style="font-family:inherit;font-size:12.5px;font-weight:600;fill:var(--text)">Green pipeline</text><text x="74.0" y="72.0" text-anchor="middle" style="font-family:inherit;font-size:10.5px;fill:var(--text-muted)">on the branch</text><rect x="160" y="30" width="128" height="58" rx="8" style="fill:var(--surface);stroke:var(--line);stroke-width:1.4;"/><text x="224.0" y="56.0" text-anchor="middle" style="font-family:inherit;font-size:12.5px;font-weight:600;fill:var(--text)">Click Deploy</text><text x="224.0" y="72.0" text-anchor="middle" style="font-family:inherit;font-size:10.5px;fill:var(--text-muted)">target: rollback</text><rect x="310" y="30" width="128" height="58" rx="8" style="fill:var(--surface);stroke:var(--line);stroke-width:1.4;"/><text x="374.0" y="56.0" text-anchor="middle" style="font-family:inherit;font-size:12.5px;font-weight:600;fill:var(--text)">Preview</text><text x="374.0" y="72.0" text-anchor="middle" style="font-family:inherit;font-size:10.5px;fill:var(--text-muted)">changes nothing</text><rect x="460" y="30" width="128" height="58" rx="8" style="fill:var(--surface);stroke:var(--accent);stroke-width:2.2;"/><text x="524.0" y="56.0" text-anchor="middle" style="font-family:inherit;font-size:12.5px;font-weight:600;fill:var(--text)">Roll back</text><text x="524.0" y="72.0" text-anchor="middle" style="font-family:inherit;font-size:10.5px;fill:var(--text-muted)">code, deps, reload</text><rect x="610" y="30" width="128" height="58" rx="8" style="fill:var(--surface);stroke:var(--line);stroke-width:1.4;"/><text x="674.0" y="56.0" text-anchor="middle" style="font-family:inherit;font-size:12.5px;font-weight:600;fill:var(--text)">Health wait</text><text x="674.0" y="72.0" text-anchor="middle" style="font-family:inherit;font-size:10.5px;fill:var(--text-muted)">green only if healthy</text><line x1="138" y1="59.0" x2="160" y2="59.0" style="stroke:var(--text-muted);stroke-width:1.5;" marker-end="url(#ah4)"/><line x1="288" y1="59.0" x2="310" y2="59.0" style="stroke:var(--text-muted);stroke-width:1.5;" marker-end="url(#ah4)"/><line x1="438" y1="59.0" x2="460" y2="59.0" style="stroke:var(--text-muted);stroke-width:1.5;" marker-end="url(#ah4)"/><line x1="588" y1="59.0" x2="610" y2="59.0" style="stroke:var(--text-muted);stroke-width:1.5;" marker-end="url(#ah4)"/><rect x="170" y="138" width="108" height="44" rx="8" style="fill:var(--surface);stroke:var(--line);stroke-width:1.4;stroke-dasharray:5 4;"/><text x="224.0" y="157.0" text-anchor="middle" style="font-family:inherit;font-size:12.5px;font-weight:600;fill:var(--text)">Typo in target</text><text x="224.0" y="173.0" text-anchor="middle" style="font-family:inherit;font-size:10.5px;fill:var(--text-muted)">nothing runs</text><line x1="224.0" y1="88" x2="224.0" y2="138" style="stroke:var(--text-muted);stroke-width:1.5;stroke-dasharray:5 4;" marker-end="url(#ah4)"/><text x="524.0" y="148" text-anchor="middle" style="font-family:inherit;font-size:11px;fill:var(--text-muted)">migrations are NOT undone</text><text x="524.0" y="164" text-anchor="middle" style="font-family:inherit;font-size:10.5px;fill:var(--text-muted)">(the preview warns if the release had some)</text></svg>

The rollback script does the careful parts so the person clicking does not have to. Every real deploy records the commit it replaced. A rollback shows a preview step first (the commit you are on, the commit you go back to, and a warning if the release you are removing added database migrations), refuses to run if someone edited files on the server, takes the same lock the deploy uses, reinstalls dependencies only if the lockfile differs, reloads, and only goes green after the health check passes. I tried it on staging with a real frontend: preview, rebuild, reload, health wait, done in about a minute and a half.

A few things went wrong while I built it.

**The locked key could not be asked to roll back.** My staging frontend key was forced to run the deploy script, and a forced command ignores what the client asks for. That means the key could never say "roll back", and worse, any request at all ran a deploy. The fix was the same pattern as production: a tiny wrapper that knows exactly three words (deploy, preview, rollback) and refuses everything else. Production's wrapper grew the same way: it started with five words and gained two for the backend rollback, still a short, fixed list.

**Re-running a deploy erased the rollback target.** The scripts saved the previous commit on every run. If you re-ran a deploy with nothing new to ship, "previous" quietly became "current", and the next rollback found nothing to go back to. I spotted it because I was about to run a no-op deploy just to get a green pipeline for my test. The target now only moves when a deploy actually changes the commit.

**Rolling back twice does not always undo it.** On most targets the script records the version you rolled back from, so a second rollback goes forward again. The production frontend is just a folder of static files that gets swapped, and its rollback republishes the saved folder without swapping it, so a second rollback changes nothing. I wrote that down in the runbook instead of adding untested swap logic to a production script. Going forward there is a normal deploy.

One limit to know about: a rollback only puts the code back. Migrations that already ran stay applied, which is why the preview warns about them. If a bad release also changed the database, the button will not fix that, and someone has to decide what to do.

One more thing, from my own test. I went to try the rollback and the pipeline I had open turned out to be a production one. The Deploy dialog does not show the branch, so typing `rollback` there would have rolled back production. I caught it before pressing anything, but it made the point: look at the pipeline title and check it says the branch you mean. That is in the runbook now.

## What actually broke

None of this worked on the first click. These are the ones worth writing down.

**1. pm2 said my app did not exist.** The deploy got all the way to the reload and then reported `Process or Namespace not found`. The app was running fine. The cause: the local backend gives every step a throwaway `HOME` directory, and pm2 keeps its state under `HOME`. So pm2 started a brand new, empty daemon in the temp folder and, correctly, found nothing. The same temp `HOME` would also have hidden my scripts' state files. The fix is one line at the top of each script that resolves the real home from the account instead of trusting the environment.

**2. "Repository not found" on a repo that exists.** Both the pipeline and the manual deploy scripts started failing on fetch with exactly that message. GitHub answers that way for a private repo when the credentials are bad, so it looks like a missing repo when it is really a dead token. The servers were using an access token embedded in the git remote URL, and it had been revoked or expired. I replaced it with a read-only deploy key per repository. One thing that trips people up: GitHub lets a deploy key be attached to only one repo, so every repo on every server gets its own key and its own SSH host alias. It is also better than the old setup because the credential belongs to the repository, not to one person's account.

**3. The dirty lockfile.** My deploy script refuses to run if tracked files have local changes, which is a good rule. It started refusing because the older hand-run deploy script used `npm install`, and a different npm version rewrites the lockfile a little each time. Switching that script to `npm ci` fixed it for good, since `npm ci` installs exactly what the lockfile says and never rewrites it.

**4. Checking health too early.** On staging the frontend runs through a preview server that takes a few seconds to bind its port after a reload. A single check right after the reload looked like a failure. The health check now waits and retries instead of looking once.

**5. Probing a locked key runs the script.** While testing the staging frontend key, I ran a harmless command through it to see what happened. The forced command ignores what you ask and runs the deploy script anyway. So my "harmless probe" was a real deploy. It was staging and it worked, but it is a good reminder that a locked key has no dry-run unless you build one.

## Who gets to click

I would have liked a role that can run pipelines and nothing else. Woodpecker does not have one. It does not keep roles of its own: it copies each user's permission on the GitHub repo. Running a pipeline needs write access, and so does editing secrets and cron jobs. Settings and deleting the repo need admin.

| Action | Needs on the repo |
|---|---|
| View pipelines and logs | read |
| Run, restart, cancel a pipeline | write |
| Edit secrets, cron jobs | write |
| Project settings | admin |

With the local backend, write access effectively means a shell as the CI user on that machine, because a workflow can run any command. So for now the group of people who can click the button is small and trusted. The clean fix is what I listed in the table earlier: move the agent to its own small VM with the container backend, so a workflow gets a container instead of the host. It is on the list. Branch protection would help too, but on private repos it needs a paid plan, so I wrote down "keep write access tight" instead.

## What it cost

| Item | Cost |
|---|---|
| New servers | none, it shares the staging VM |
| Licences | none |
| Memory while idle | about 70 MB |
| My time | a few evenings, most of it on the five problems above |

## What I would tell someone starting

Keep the logic in scripts you can run by hand, and treat the CI tool as a button on top. Make production access a locked key that can only do a short list of things. Test the failure paths on staging first, because the first real run will find something. And write down who can click the button before you hand it out, because the answer is almost always "more than you meant".

Everything here is from one small setup, so treat the numbers as an example and not a promise. But the core idea holds: you do not need a new server or a new bill to stop deploying by hand.
