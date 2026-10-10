# Changelog

## 2.1.7 - 2026-10-10

- Keep every overlapping duration or pHash group's recommended keeper out of bulk deletion selections.
- Repair keeper safety when selecting a filtered or individual group while other groups remain selected.

## 2.1.6 - 2026-10-09

- Copy generated video segments to the keeper when confirmed metadata cleanup removes a video whose primary file is within one second of the keeper's primary file.
- Preserve user markers for same-length videos when Cove's fingerprint check would otherwise leave them behind, and avoid copying segments already on the keeper.

## 2.1.5 - 2026-10-09

- Match scanned photos without metadata titles by their filename stems in Same title mode.
- Add a dedicated Same filename mode for photos, ignoring file extensions and metadata titles.
- Include matching files that Cove attached to the same photo record, with file-level keeper selection.
- Use the video-style cleanup dialog for photos, including source-file, generated-file, and metadata choices.

## 2.1.4 - 2026-10-09

- Add Select all recommended, individual group selection, and a bulk cleanup bar to Photo mode.
- Process selected photo groups in one server job with progress and per-group failure reporting.

## 2.1.3 - 2026-10-09

- Add a Videos/Photos selector to Duplicate Finder, with Videos as the default.
- Find duplicate photos by exact MD5/OSHash fingerprint, visual pHash distance, or title, with include/exclude folder scope.
- Recommend the highest-resolution photo as keeper and use smaller file size to break resolution ties.
- Merge photo metadata into the keeper during reviewed cleanup and preserve every keeper-owned file.

## 2.1.2 - 2026-10-08

- Add a separate fractional-second delta to duration matching, defaulting to zero.
- Compare duration matches within the same immediate parent folder by default, with an option to compare across all folders.
- Preserve folder and delta settings in saved defaults and shareable search links.

## 2.1.1 - 2026-10-08

- Add exact-duration duplicate search using each video's longest file duration, with no pHash or duration-delta tolerance.
- Require a warning confirmation when selecting exact duration and before automatic searches that restore it from a URL or saved setting.
- Show the matched duration on each result group and exclude missing or zero file durations.

## 2.1.0 - 2026-09-30

- Replace the removed synchronous search with an extension-owned Cove background job and core persisted-result endpoints.
- Remove candidate, retained-row/memory, visual-comparison/match, and result-group admission caps; retain cancellation, paged loading/persistence and field validation.
- Union visual matches as they are found rather than retaining every matching pair.
- Resume pending searches after refresh and expose cancellation in the search page.
- Use Cove core duplicate resolution for reviewed video cleanup, metadata/provenance migration, keeper reservations, and physical deletion.
- Preserve explicit keeper covers or fill generated keeper covers from explicit donors, independently of metadata overwriting.
- Require Cove 1.5.1 and pin build/CI contracts to v1.5.1.
- Include AGPL-3.0 license/attribution for the adapted Cove search worker.

## 2.0.3 - 2026-08-26

- Queue video duplicate cleanup as a Cove background job so metadata copying and deletion continue independently of the extension page.
- Move reviewed duplicate-image metadata merging and permanent file cleanup into the same server-owned job workflow.
- Preserve per-video progress, warnings, and partial-failure reporting while processing each duplicate in an isolated service scope.

## 2.0.2 - 2026-08-20

- Keep deletion progress text stable across metadata and deletion stages, updating only the current video number.
- Build releases against pinned Cove 1.1.0 contracts so the complete backend is compiled in CI.

## 2.0.1 - 2026-08-20

- Restore the 1.9.7 metadata-first video deletion flow and pass permanent source-file deletion directly to Cove.
- Remove `.dedup-trash` creation and recovery management from video and image cleanup.
- Make reviewed image cleanup explicitly permanent while continuing to protect archive entries.
- Run the complete regression suite as a mandatory part of frontend and package builds.

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
