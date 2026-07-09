---
title: "Fixing Truncated JSON Responses as Data Grows"
description: "How growing admin data exposed fragile one-shot API reads, broke exports and filters, and why paginated aggregation became the reliable fix."
pubDate: 2026-07-01
tags:
  - realtime-systems
  - debugging
  - api
  - frontend
  - reliability
  - performance
draft: false
---
One of the more interesting failures in admin dashboards is the kind that does not look like a backend failure at first.

The API returns `200 OK`. The endpoint works in small test cases. The same screen may have been running fine for months. Then, as more users join the system and the amount of data grows, exports start failing, filters load empty, and the browser reports a JSON parse error.

That is the problem we ran into.

This post is about the shape of that failure, how we separated the noisy browser errors from the real signal, and why the fix was not "increase the timeout." The fix was to stop treating growing data as something we could safely move through one giant JSON response.

All product, domain, and company-specific details have been intentionally removed.

## The Symptom

Several admin screens started failing with errors like this:

```text
SyntaxError: JSON.parse: unterminated string at line 1 column ...
```

In the browser network tab, the failing request often had one or more of these signals:

- `NS_ERROR_NET_PARTIAL_TRANSFER`
- a response body cut off in the middle of JSON
- an HTTP status that still appeared as `200`

The user-facing impact was wider than one broken API call:

- Excel exports failed
- filter dropdowns loaded with no options
- page initialization became brittle
- counts shown in the UI did not always feel consistent with exported rows

At first glance, this can be confusing. If the status is `200`, why is the frontend failing?

Because HTTP success only tells us the response started successfully. It does not guarantee the browser received a complete, valid JSON document.

## Why It Started Happening

The system had grown.

Earlier, a "load everything" request was small enough to work. Later, the same request returned much more data because there were more users, more records, more joins, and more historical activity behind the same admin screen.

The frontend was asking for large payloads in a few places:

- export endpoints that returned the full filtered dataset in one response
- filter setup endpoints that attempted to load every possible option at page boot
- helper requests using high limits like `5000` or `10000`

That approach is fragile. Once a response becomes large enough, real production conditions start to matter:

- a proxy or server may close the connection early
- compressed or chunked transfer may be interrupted
- the browser may receive only part of the payload
- the client may still try to parse the incomplete body as JSON

The frontend does not receive "half a result." It receives invalid JSON, and the whole request fails.

## The Misleading Error

During debugging, Firefox also showed this error in some cases:

```text
NS_BINDING_ABORTED
```

That looked suspicious, but it was not the root cause.

In practice, `NS_BINDING_ABORTED` often means the browser intentionally canceled an older request because:

- a newer request replaced it
- an `AbortController` cleanup ran
- the component unmounted
- a re-render superseded the previous fetch

If a newer request succeeds and the UI loads correctly, `NS_BINDING_ABORTED` is usually just noise.

The real signal was different:

- `NS_ERROR_NET_PARTIAL_TRANSFER`
- truncated response bodies
- JSON parse failures on large payloads

That combination pointed to incomplete transfer of oversized responses.

## The Root Cause Pattern

Three frontend assumptions caused the system to become unreliable as data grew.

First, export buttons depended on a single backend response containing the full dataset.

Second, filter bootstrapping used "load all" requests during page initialization.

Third, some pagination logic assumed that a short page meant there was no more data.

That third one is subtle. The shortcut usually looks like this:

```js
if (rows.length < limit) {
  stopFetching();
}
```

It seems reasonable, but it is not always safe.

If the backend query includes joins, grouping, or deduplication, one page can return fewer unique rows than the requested limit even when later pages still contain more records. Stopping based on `rows.length < limit` can silently miss data.

For exports, that is especially dangerous. A user expects the export to include every row matching the current filters, not only the rows that happened to arrive before a frontend shortcut stopped fetching.

## The Fix

The durable fix was to stop trusting one giant response and move large reads to paginated aggregation.

Instead of this:

```js
const res = await client.get('/api/admin/export', { params });
return res.data.rows;
```

the frontend now follows this pattern:

1. Fetch page 1 with a manageable limit.
2. Read the API's `count`.
3. Calculate how many pages exist.
4. Fetch each page in batches.
5. Merge the rows client-side.
6. Generate the export from the merged result.

The helper looked like this:

```js
async function fetchAllPages(fetchPage, baseParams, batchLimit = 100) {
  const allRows = [];

  const firstPage = await fetchPage({
    ...baseParams,
    page: 1,
    limit: batchLimit,
  });

  allRows.push(...(firstPage.rows ?? []));

  const totalCount = firstPage.count ?? allRows.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / batchLimit));

  for (let page = 2; page <= totalPages; page += 1) {
    const result = await fetchPage({
      ...baseParams,
      page,
      limit: batchLimit,
    });

    allRows.push(...(result.rows ?? []));
  }

  return {
    count: totalCount,
    rows: allRows,
  };
}
```

This changed the failure profile immediately.

Each individual response stayed small and predictable. The browser no longer had to parse a dangerously large JSON document. The export still included the full filtered dataset.

## Why `count` Matters

The important part is that the loop stops based on the API's `count`, not the size of the current page.

The better rule is:

- fetch page 1
- read `count`
- calculate `Math.ceil(count / batchLimit)`
- fetch every page up to that total

That avoids silent data loss when joins or grouping make a page appear short.

If the backend can repeat records because of joins, the merged result may also need deduplication by a stable record ID. The key is to make that deduplication explicit instead of accidentally depending on page size behavior.

## Making Page Boot More Resilient

Exports were not the only problem. Some admin pages loaded multiple filter sources during initialization.

The original pattern looked like this:

```js
const [a, b] = await Promise.all([fetchA(), fetchB()]);
```

That works only when every request succeeds. If one oversized request fails, the entire `Promise.all(...)` rejects and unrelated filters can appear empty too.

For independent filter sources, the safer pattern is:

```js
const [a, b] = await Promise.allSettled([fetchA(), fetchB()]);
```

With `Promise.allSettled(...)`, successful sources can still populate the UI while failed sources degrade gracefully. That matters in admin screens because filter state is often assembled from several independent endpoints.

## Preserving User Expectations

One tempting fix would have been to export only the current page.

That would reduce payload size, but it would also change the product behavior. Users do not expect "export" to mean "export only what is visible right now" unless the UI says that clearly.

The expected behavior was:

> Export all records matching the active filters.

So the goal was not to reduce the dataset semantically. The goal was to fetch the same dataset safely.

That meant preserving:

- active filters
- sort order
- total matching records
- Excel output shape

Only the transport strategy changed.

## A Small Count Cleanup

During the investigation, we also found a UI count that was labeled as one entity type even though the backend count represented another underlying record type.

That kind of mismatch creates unnecessary confusion. Users compare:

- the footer count
- grouped rows on the screen
- rows in the exported spreadsheet

If those numbers are based on different concepts, even a correct export can look wrong.

Grouped admin screens should be very clear about what is being counted.

## What Changed

The final implementation followed a few rules:

- replace oversized one-shot export requests with paginated batch fetching
- replace high helper limits with smaller paginated requests
- use API `count` to determine total pages
- deduplicate merged rows when joins can repeat records
- use `Promise.allSettled(...)` for independent filter bootstrapping
- treat `NS_BINDING_ABORTED` as normal only when a newer request succeeds

## The Result

After the change:

- exports completed reliably
- filter dropdowns loaded consistently
- page initialization became more resilient
- large reads scaled with data growth
- the browser no longer depended on parsing giant JSON responses

The important lesson for me was that this was not a random browser issue. It was a system design issue showing up at the frontend boundary.

As data grows, "just load everything" slowly turns from convenient to fragile.

## Takeaways

If an admin dashboard starts failing with JSON parse errors during exports or filter loading, check for these smells:

- export endpoints returning the full dataset in one response
- helper endpoints trying to load everything during page boot
- very high `limit` values used as shortcuts
- frontend pagination that stops when `rows.length < limit`
- grouped UIs where display counts and export counts mean different things

The fix is usually not to retry harder.

The fix is to make large reads intentional: paginate them, aggregate them, and keep each response small enough to be boring.
