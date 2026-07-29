# Changelog

## 1.9.1 - 2026-07-29

- Retry failed comparison transcodes at source resolution and lower Cove profiles before reporting an FFmpeg failure.
- Keep the Video A and Video B selectors visible in equal-width columns when titles are long.

## 1.9.0 - 2026-07-29

- Add bulk duplicate discovery and deletion using exact fingerprints, pHash distance, titles, or remote IDs.
- Add synchronized side-by-side comparison with Cove-compatible direct playback and FFmpeg transcoding.
- Add configurable keeper priorities, folder scopes, minimum duration, custom page sizes, and URL-persisted controls.
- Add comprehensive metadata transfer from deleted videos to the selected keeper.
- Treat duration differences that display as zero as matches in the pHash comparison summary.
