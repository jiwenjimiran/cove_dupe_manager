# Changelog

## 2.0.0 - 2026-08-15

- Add balanced, codec-aware keeper ranking with an explanation for each recommendation while retaining A's custom rule mode.
- Score risky visual-match groups, sort them first for review, and exclude high-risk groups from safe bulk selection.
- Preserve per-user affinities, ratings, bookmarks, and interactions when duplicate videos are merged.
- Stage source-file cleanup through recoverable `.dedup-trash` folders; permanent deletion remains limited to exact fingerprint matches.
- Add a review-only duplicate-image page using Cove's stored pHashes, metadata/engagement merging, protected archive entries, and recoverable cleanup.
- Require the corresponding Cove read/write/delete permission on every extension endpoint.

## 1.9.7 - 2026-07-30

- Refresh Cove authentication in place during long-running deletion jobs and retry an interrupted request once without reloading the page.
- Copy metadata and delete each selected video independently so completed deletions remain completed when a later video fails.
- Reconcile ambiguous deletion responses, preserve unresolved videos, and report exact completed, failed, interrupted, and not-attempted counts.
- Show live per-video metadata and deletion progress for long jobs.

## 1.9.6 - 2026-07-30

- Clarify that an in-progress bulk deletion might take a while.

## 1.9.5 - 2026-07-29

- Keep the custom groups-per-page input stable while typing and commit it only on blur or Enter.
- Treat cover-art transfer failures as warnings so metadata copying and bulk deletion can continue.
- Preserve videos from groups with fatal metadata-copy errors while deleting eligible videos from other groups.

## 1.9.4 - 2026-07-29

- Persist the result-filter search query in the URL and restore it on refresh.
- Add saved metadata-copy and dependent conflict-overwrite defaults to extension settings.
- Allow deletion-time metadata transfer to overwrite conflicting fields, ratings, and cover artwork when explicitly enabled.

## 1.9.3 - 2026-07-29

- Copy a deleted video's generated screenshot cover when it has no explicit `imagePath`.
- Prefer explicit covers and try additional deleted videos when a cover endpoint is unavailable.

## 1.9.2 - 2026-07-29

- Authenticate comparison, preview, and screenshot media URLs using Cove's access-token or share-session query parameters.
- Prevent authenticated transcode requests from being masked as missing-video `404` responses.

## 1.9.1 - 2026-07-29

- Retry failed comparison transcodes at source resolution and lower Cove profiles before reporting an FFmpeg failure.
- Keep the Video A and Video B selectors visible in equal-width columns when titles are long.

## 1.9.0 - 2026-07-29

- Add bulk duplicate discovery and deletion using exact fingerprints, pHash distance, titles, or remote IDs.
- Add synchronized side-by-side comparison with Cove-compatible direct playback and FFmpeg transcoding.
- Add configurable keeper priorities, folder scopes, minimum duration, custom page sizes, and URL-persisted controls.
- Add comprehensive metadata transfer from deleted videos to the selected keeper.
- Treat duration differences that display as zero as matches in the pHash comparison summary.
