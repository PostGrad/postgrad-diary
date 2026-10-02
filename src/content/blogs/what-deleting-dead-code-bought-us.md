---
title: "What Deleting Dead Code Bought Us in a Node Backend"
description: "I cleaned out years of unused integrations and boilerplate from an Express backend, then measured the before and after. Here is how I decided what was safe to delete, the mistake that almost shipped, and the numbers."
pubDate: 2026-10-02
tags:
  - nodejs
  - refactoring
  - eslint
  - performance
  - backend
draft: false
---

The backend I work on has been touched by several teams over the years. A few weeks ago I opened the repo with one goal: find out how much of it we actually use. The answer was not great. There was a chat server nobody connected to, code for payment and SMS providers that nothing called, a second database layer for a database we don't run, and a router full of test endpoints from a different company's starter project. Some of it was imported by something, so it all looked alive.

I decided to delete as much as I safely could, and then measure what it bought us, instead of just assuming it helped. This post is about how I decided what was safe, the one automated edit that nearly caused real damage, and the numbers at the end.

## Grep is not enough

The first trap is thinking "no callers in this repo" means dead. Our backend serves a web app and two mobile apps, so I checked all three codebases before removing anything.

That check paid off. The newer mobile app was supposed to use Keycloak for login. I had even told myself it did. It doesn't. It still calls the old login endpoint and uses the old refresh endpoint. If I had removed those as "legacy", the app would have broken on the day it shipped. Those routes stay until that app moves over, and I wrote that down so the next cleanup doesn't repeat the mistake.

For the rest, I used a few cheap tests instead of trusting a text search:

- **Reachability.** Start from the server entry point and the npm scripts, follow every `require`, and list what is never reached. Whole folders fell out of this.
- **Does the thing it calls even exist?** Several functions wrote to database models that were never defined, or imported helpers that were never exported. If it can't run today, deleting it can't break anything.
- **Is it imported but never used?** Plenty of files pulled in a package and never touched it.
- **Ask production.** For push notifications I didn't argue about the code. I ran one query on the sessions table: several thousand rows, zero with a push token. Nothing had ever registered one.

## Fixing lint properly

The repo had an ESLint config that failed on almost every file with "Unexpected token =>". It was set to a parser version from 2016, which can't read async arrow functions. Nobody could have been running it.

I set it to a modern parser and used the recommended rules plus one strict rule: unused variables are errors, and unused function arguments are errors unless the name starts with an underscore.

```json
"no-unused-vars": ["error", {
  "args": "all",
  "argsIgnorePattern": "^_",
  "caughtErrors": "all",
  "caughtErrorsIgnorePattern": "^_"
}]
```

That turned up about 500 problems. Most were unused imports and variables, plus a lot of `const { id } = req?.params`, which ESLint flags because `?.` doesn't protect a destructuring. Removing the `?` gives the same behavior as before (it threw a TypeError then and still does), just honestly.

I didn't want to hand-edit 100 files, so I wrote a small script that parses each file into a syntax tree and removes unused imports, variables and trailing arguments. Where an argument can't be removed, because a later one is used, it gets an underscore prefix.

## The mistake that almost shipped

Later I added a second pass to remove leftover statements that do nothing, like a bare `new Something();` line. My rule was simple: if a statement has no function call or assignment, it has no effect, so delete it.

Look at this line:

```js
delete user.password;
```

No call, no assignment. My script decided it was useless and removed it. It also removed `delete query.page` and about fifty other `delete` statements, including the one that stops a password hash from going out in an API response.

I caught it because the script printed everything it removed, and a wall of `delete ...` lines was clearly wrong. I restored them from a snapshot and then checked that the count of `delete` statements per file matched the snapshot exactly. Three had landed in the wrong place and I fixed those by hand.

The lesson I took from it: automated edits are only as safe as your check afterwards. I compare against a baseline every time now. I ran every test file before and after, and the pass and fail counts had to match exactly (890 passing and 20 failing both times, the 20 being old failures unrelated to this work).

## Measuring it

To get an honest before and after, I checked out the commit from before the cleanup into a separate folder and installed its original dependencies there. Then I wrote a tiny script that loads the app's config, libraries, services and routes with a stubbed database and prints the load time and memory.

My first "before" result looked great for the cleanup. Too great. The old version crashed halfway through loading because a Firebase setup step wanted real credentials, so it had only loaded a fraction of its modules and finished early. I only noticed because the number of loaded files was far lower than the new version's. After giving it dummy credentials so it loaded everything, I got a fair comparison. Always check that both sides did the same amount of work.

Six runs each, median values:

| Metric | Before | After | Gain |
| --- | ---: | ---: | ---: |
| Module load time | 920 ms | 486 ms | 47% faster |
| Memory (RSS) at startup | 274 MB | 195 MB | 29% less |
| JS heap at startup | 126 MB | 70 MB | 44% less |
| npm packages loaded | 379 | 234 | 38% fewer |
| Production dependencies | 58 | 35 | 40% fewer |
| Top-level packages in node_modules | 864 | 512 | 41% fewer |
| node_modules size | 553 MB | 169 MB | 69% smaller |

## What it did and didn't change

The app loads its modules in about half the time, so starts and restarts are quicker, and a running process holds roughly 80 MB less memory. On the small servers we use, that matters. Installs are faster too, because we download about a third of what we used to.

Request speed did not change in any way I could measure. I didn't touch a hot path, and I'd be suspicious of anyone claiming a cleanup like this speeds up their API. The honest summary is that most of the value is somewhere else: fewer packages to patch when a security advisory lands, fewer places for a bug to hide, and a repo where the code you read is code that runs.

## What I'd do differently

- Run the whole test suite first and save the results. Everything else I did leaned on that baseline.
- Delete in small, themed commits so a bad one is easy to revert.
- Keep a short list of things that look dead but aren't, like that login route, so the next person doesn't have to rediscover them.
- Print what a cleanup script removes. Reading its output is what saved me.
