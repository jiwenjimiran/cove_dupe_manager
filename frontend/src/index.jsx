import React from "@cove/runtime/react";
import {
  AlertTriangle, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Check, ChevronDown,
  ChevronRight, Columns2, Copy, Folder, Loader2, Pause, Play, RefreshCw, RotateCcw,
  Save, Search, Settings2, Trash2, X,
} from "@cove/runtime/lucide-react";
import { copyVideoMetadata, deleteVideos, findDuplicates, loadFolders, loadSettings, loadTranscodeResolutions, mediaUrls, saveSettings } from "./api.js";
import {
  DEFAULT_SETTINGS, RULE_LABELS, autoSelectForDeletion, chooseKeeper, comparisonPlayback,
  duplicateSearchFromUrl, duplicateSearchToUrl, filterGroups, formatBytes,
  displayPath, formatDuration, formatDurationInput, metadataCopyCount, metadataCount, normalizeSettings, parseDurationInput,
  phashComparison, prepareGroups, primaryFile, selectedSummary, transcodeResolutionCandidates, validateKeeperSafety,
} from "./core.js";
import { clearSession, getSession } from "./session.js";

const { useEffect, useMemo, useRef, useState } = React;

export function DuplicateManagerPage({ onNavigate }) {
  const session = getSession();
  const initialUrlSearch = useRef(duplicateSearchFromUrl(typeof window === "undefined" ? "" : window.location.search)).current;
  const initialSettings = useRef(normalizeSettings({ ...(session.searchSettings || DEFAULT_SETTINGS), ...initialUrlSearch.settings })).current;
  const autoSearchStarted = useRef(false);
  const [settings, setSettings] = useState(initialSettings);
  const [appliedSettings, setAppliedSettings] = useState(session.searchSettings ? normalizeSettings(session.searchSettings) : null);
  const [rawGroups, setRawGroups] = useState(session.rawGroups);
  const [query, setQuery] = useState(initialUrlSearch.hasSearchParams ? initialUrlSearch.query : session.query);
  const [page, setPage] = useState(initialUrlSearch.hasSearchParams ? initialUrlSearch.page : session.page);
  const [selectedIds, setSelectedIds] = useState(new Set(session.selectedIds));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [compareGroup, setCompareGroup] = useState(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteStatus, setDeleteStatus] = useState(session.deletion?.status || "idle");
  const [folderOpen, setFolderOpen] = useState(false);
  const [dismissedGroupKeys, setDismissedGroupKeys] = useState(new Set(session.dismissedGroupKeys || []));
  const [settingsReady, setSettingsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadSettings().then((value) => {
      if (cancelled) return;
      const next = normalizeSettings({ ...(session.searchSettings || value), ...initialUrlSearch.settings });
      setSettings(next);
      setSettingsReady(true);
      if (initialUrlSearch.hasSearchParams && !autoSearchStarted.current) {
        autoSearchStarted.current = true;
        runSearch(next, initialUrlSearch.page);
      }
    }).catch((reason) => {
      if (cancelled) return;
      setError(reason.message);
      setSettingsReady(true);
      if (initialUrlSearch.hasSearchParams && !autoSearchStarted.current) {
        autoSearchStarted.current = true;
        runSearch(initialSettings, initialUrlSearch.page);
      }
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!settingsReady || typeof window === "undefined") return;
    const search = duplicateSearchToUrl(window.location.search, settings, page, query);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${search}${window.location.hash}`);
  }, [settings, page, query, settingsReady]);

  useEffect(() => {
    const operation = session.deletion;
    if (!operation?.promise || operation.status !== "pending") return;
    let active = true;
    operation.promise.then(() => { if (active) setDeleteStatus("complete"); }).catch((reason) => {
      if (!active) return;
      setRawGroups(session.rawGroups);
      setDeleteStatus("failed");
      setError(`${reason.message || "Deletion failed."} Results were restored; run the search again to reconcile any partial deletion.`);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => { session.query = query; session.page = page; session.selectedIds = new Set(selectedIds); }, [query, page, selectedIds]);

  const preparedGroups = useMemo(() => rawGroups ? prepareGroups(rawGroups, appliedSettings || settings) : [], [rawGroups, appliedSettings]);
  const groups = useMemo(() => preparedGroups.filter((group) => !dismissedGroupKeys.has(groupKey(group))), [preparedGroups, dismissedGroupKeys]);
  const filteredGroups = useMemo(() => filterGroups(groups, query), [groups, query]);
  const totalPages = Math.max(1, Math.ceil(filteredGroups.length / settings.pageSize));
  const visibleGroups = filteredGroups.slice((Math.min(page, totalPages) - 1) * settings.pageSize, Math.min(page, totalPages) * settings.pageSize);
  const summary = useMemo(() => selectedSummary(groups, selectedIds), [groups, selectedIds]);
  const unsafeGroups = useMemo(() => validateKeeperSafety(groups, selectedIds), [groups, selectedIds]);

  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);

  async function runSearch(options = settings, resultPage = 1) {
    const searchSettings = normalizeSettings(options);
    setLoading(true);
    setError("");
    try {
      const result = await findDuplicates(searchSettings);
      setRawGroups(result);
      setSelectedIds(new Set());
      setDismissedGroupKeys(new Set());
      setPage(Math.max(1, Math.trunc(Number(resultPage)) || 1));
      session.rawGroups = result;
      const snapshot = { ...searchSettings, includedPaths: [...searchSettings.includedPaths] };
      setAppliedSettings(snapshot);
      session.searchSettings = snapshot;
      session.selectedIds = new Set();
      session.dismissedGroupKeys = new Set();
      session.stale = false;
    } catch (reason) {
      setError(reason.message || "Duplicate search failed.");
    } finally {
      setLoading(false);
    }
  }

  function updateSettings(patch) {
    setSettings((current) => normalizeSettings({ ...current, ...patch }));
  }

  function toggleSelected(id) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function selectRecommended(targetGroups = filteredGroups) {
    const targetIds = new Set(targetGroups.flat().map((video) => video.id));
    const recommended = autoSelectForDeletion(targetGroups, settings);
    setSelectedIds((current) => new Set([...current].filter((id) => !targetIds.has(id)).concat([...recommended])));
  }

  function clearSelected(targetGroups = filteredGroups) {
    const targetIds = new Set(targetGroups.flat().map((video) => video.id));
    setSelectedIds((current) => new Set([...current].filter((id) => !targetIds.has(id))));
  }

  function dismissGroup(group) {
    const next = new Set(dismissedGroupKeys).add(groupKey(group));
    const remainingIds = new Set(preparedGroups.filter((candidate) => !next.has(groupKey(candidate))).flat().map((video) => video.id));
    setDismissedGroupKeys(next);
    setSelectedIds((current) => new Set([...current].filter((id) => remainingIds.has(id))));
    session.dismissedGroupKeys = next;
  }

  async function confirmDelete(options) {
    const ids = [...selectedIds];
    if (ids.length === 0 || unsafeGroups.length > 0) return;
    setConfirmOpen(false);
    setDeleteStatus("pending");
    setError("");
    const previous = rawGroups;
    const idSet = new Set(ids);
    if (options.copyMetadata) {
      const plans = groups.filter((group) => group.some((video) => idSet.has(video.id))).map((group) => ({
        target: chooseKeeper(group.filter((video) => !idSet.has(video.id)), appliedSettings || settings),
        sources: group.filter((video) => idSet.has(video.id)).map((video) => video.id),
      }));
      try {
        for (const plan of plans) await copyVideoMetadata(plan.target.id, plan.sources, { overwriteConflicts: options.overwriteConflictingMetadata });
      } catch (reason) {
        setDeleteStatus("failed");
        setError(`${reason.message || "Metadata copy failed."} No videos were deleted.`);
        return;
      }
    }
    const optimistic = (rawGroups || []).map((group) => group.filter((video) => !idSet.has(video.id))).filter((group) => group.length > 1);
    setRawGroups(optimistic);
    setSelectedIds(new Set());
    session.rawGroups = optimistic;
    session.selectedIds = new Set();
    const operation = { status: "pending", ids, promise: null };
    operation.promise = deleteVideos(ids, options)
      .then(() => { operation.status = "complete"; session.deletion = operation; return "complete"; })
      .catch((reason) => {
        operation.status = "failed";
        operation.error = reason.message || "Deletion failed.";
        session.rawGroups = previous;
        session.stale = true;
        session.deletion = operation;
        throw reason;
      });
    session.deletion = operation;
    try {
      await operation.promise;
      setDeleteStatus("complete");
    } catch (reason) {
      setRawGroups(previous);
      setDeleteStatus("failed");
      setError(`${reason.message || "Deletion failed."} Results were restored; run the search again to reconcile any partial deletion.`);
    }
  }

  function resetSession() {
    clearSession();
    setRawGroups(null);
    setAppliedSettings(null);
    setSelectedIds(new Set());
    setQuery("");
    setPage(1);
    setDeleteStatus("idle");
    setDismissedGroupKeys(new Set());
  }

  return <div className="dm-page">
    <header className="dm-header">
      <div><div className="dm-title"><Copy size={23} /><h1>Duplicate Manager</h1></div><p>Compare, select, and remove duplicate videos in one operation.</p></div>
      {rawGroups && <button className="dm-icon-button" title="Clear cached results" onClick={resetSession}><RotateCcw size={18} /></button>}
    </header>

    <section className="dm-controls">
      <label><span>Match type</span><select value={settings.matchType} onChange={(event) => updateSettings({ matchType: event.target.value })}><option value="fingerprint">Exact fingerprint</option><option value="phash">Visual pHash</option><option value="title">Same title</option><option value="remoteid">Same remote ID</option></select></label>
      {settings.matchType === "fingerprint" && <label><span>Algorithm</span><select value={settings.fingerprintAlgorithm} onChange={(event) => updateSettings({ fingerprintAlgorithm: event.target.value })}><option value="any">MD5 or OSHash</option><option value="md5">MD5 only</option><option value="oshash">OSHash only</option></select></label>}
      {settings.matchType === "phash" && <>
        <label><span>Maximum pHash distance</span><input type="number" min="0" max="64" value={settings.phashDistance} onChange={(event) => updateSettings({ phashDistance: Number(event.target.value) })} /></label>
        <label><span>Duration delta (sec)</span><input type="number" min="0" value={settings.maxDurationDelta} onChange={(event) => updateSettings({ maxDurationDelta: Number(event.target.value) })} /></label>
      </>}
      <DurationInput label="Minimum length" value={settings.minimumDuration} onChange={(minimumDuration) => updateSettings({ minimumDuration })} />
      <FolderScopeControl settings={settings} onChange={updateSettings} onPick={() => setFolderOpen(true)} />
      <button className="dm-primary" disabled={loading} onClick={() => runSearch()}>{loading ? <Loader2 className="dm-spin" size={17} /> : <Search size={17} />}{loading ? "Searching" : "Find duplicates"}</button>
    </section>

    {error && <div className="dm-alert dm-error"><AlertTriangle size={17} /><span>{error}</span><button onClick={() => setError("")}><X size={15} /></button></div>}
    {deleteStatus === "pending" && <div className="dm-alert"><Loader2 className="dm-spin" size={17} />Deleting {summary.videos || "selected"} videos in the background. You can leave this page.</div>}
    {deleteStatus === "complete" && <div className="dm-alert dm-success"><Check size={17} />Bulk deletion finished.</div>}

    {rawGroups && <div className="dm-result-toolbar">
      <div className="dm-search"><Search size={16} /><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Filter title, path, performer, studio, tag, or codec" /></div>
      <PageSizeControl value={settings.pageSize} onChange={(pageSize) => updateSettings({ pageSize })} />
      <button className="dm-secondary" onClick={() => selectRecommended(filteredGroups)}>Select all but keepers</button>
      <button className="dm-secondary" onClick={() => clearSelected(filteredGroups)}>Clear selection</button>
    </div>}

    {rawGroups && <div className="dm-summary">
      <span><strong>{filteredGroups.length}</strong> groups</span><span><strong>{filteredGroups.reduce((sum, group) => sum + group.length, 0)}</strong> videos</span>
      <span className="dm-summary-selected"><strong>{summary.videos}</strong> selected, {formatBytes(summary.bytes)}</span>
    </div>}

    {rawGroups && filteredGroups.length === 0 && <div className="dm-empty"><Check size={44} /><h2>No duplicate groups</h2><p>Change the filters or run a different match.</p></div>}

    <div className="dm-groups">{visibleGroups.map((group, index) => <DuplicateGroup
      key={group.map((video) => video.id).join("-")}
      group={group}
      number={(page - 1) * settings.pageSize + index + 1}
      settings={settings}
      matchSettings={appliedSettings || settings}
      selectedIds={selectedIds}
      onToggle={toggleSelected}
      onSelectRecommended={() => selectRecommended([group])}
      onDismiss={() => dismissGroup(group)}
      onCompare={() => setCompareGroup(group)}
      onNavigate={onNavigate}
    />)}</div>

    {rawGroups && filteredGroups.length > 0 && <Pagination page={page} totalPages={totalPages} onChange={setPage} />}

    {summary.videos > 0 && <div className="dm-delete-bar">
      <div><strong>{summary.videos} videos selected</strong><span>{summary.files} files, {formatBytes(summary.bytes)}</span></div>
      {unsafeGroups.length > 0 && <span className="dm-safety"><AlertTriangle size={15} />Keep at least one video in every affected group.</span>}
      <button className="dm-danger" disabled={unsafeGroups.length > 0 || deleteStatus === "pending"} onClick={() => setConfirmOpen(true)}><Trash2 size={17} />Delete selected</button>
    </div>}

    {compareGroup && <CompareDialog group={compareGroup} matchSettings={appliedSettings || settings} selectedIds={selectedIds} onToggle={toggleSelected} onClose={() => setCompareGroup(null)} />}
    {confirmOpen && <DeleteDialog summary={summary} defaults={settings} onCancel={() => setConfirmOpen(false)} onConfirm={confirmDelete} />}
    {folderOpen && <FolderDialog mode={settings.folderMode} selected={settings.includedPaths} onCancel={() => setFolderOpen(false)} onApply={(paths) => { updateSettings({ includedPaths: paths }); setFolderOpen(false); }} />}
  </div>;
}

function DuplicateGroup({ group, number, settings, matchSettings, selectedIds, onToggle, onSelectRecommended, onDismiss, onCompare, onNavigate }) {
  const keeper = chooseKeeper(group, settings);
  return <section className="dm-group">
    <header><div><strong>Group {number}</strong><span>{group.length} videos</span></div><div>
      <button className="dm-secondary" onClick={onCompare}><Columns2 size={15} />Compare</button>
      <button className="dm-secondary" onClick={onSelectRecommended}>Keep recommended</button>
      <button className="dm-icon-button" title="Remove this comparison" aria-label="Remove this comparison" onClick={onDismiss}><X size={16} /></button>
    </div></header>
    <div className="dm-video-grid">{group.map((video) => <VideoCard key={video.id} video={video} reference={keeper} phashThreshold={matchSettings.matchType === "phash" ? matchSettings.phashDistance : null} selected={selectedIds.has(video.id)} recommended={keeper?.id === video.id} onToggle={() => onToggle(video.id)} onOpen={() => onNavigate({ page: "video", id: video.id })} />)}</div>
  </section>;
}

function VideoCard({ video, reference, phashThreshold, selected, recommended, onToggle, onOpen }) {
  const file = primaryFile(video);
  const copyCount = recommended ? 0 : metadataCopyCount(reference, video);
  const [previewing, setPreviewing] = useState(false);
  return <article className={`dm-video-card ${selected ? "dm-selected" : ""}`}>
    <div className="dm-media" onMouseEnter={() => setPreviewing(true)} onMouseLeave={() => setPreviewing(false)}>
      <button className={`dm-check ${selected ? "dm-check-on" : ""}`} aria-label={selected ? "Do not delete" : "Mark for deletion"} onClick={onToggle}>{selected && <Check size={14} />}</button>
      {recommended && <span className="dm-keeper">Recommended keeper</span>}
      <img src={mediaUrls.screenshot(video.id, video.updatedAt)} alt="" loading="lazy" />
      {previewing && <video src={mediaUrls.preview(video.id)} autoPlay muted loop playsInline preload="none" />}
    </div>
    <div className="dm-video-info">
      <a className="dm-video-title" href={`/video/${video.id}`} onClick={(event) => {
        if (event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
          event.preventDefault();
          onOpen();
        }
      }}>{video.title || file?.basename || `Video #${video.id}`}</a>
      <div className="dm-facts"><span>{file ? `${file.width || 0}x${file.height || 0}` : "No file"}</span><span>{file?.videoCodec || "unknown codec"}</span><span>{formatDuration(file?.duration)}</span><span>{formatBytes(file?.size)}</span><span>{Math.round(Number(file?.bitRate || 0) / 1000)} kbps</span><span>{metadataCount(video)} metadata</span></div>
      {phashThreshold !== null && !recommended && <PhashSummary left={reference} right={video} threshold={phashThreshold} />}
      {copyCount > 0 && <p className="dm-metadata-copy"><Copy size={13} />{copyCount} metadata will be copied</p>}
      <p className="dm-file-path" title={file?.path}>{displayPath(file?.path || "No path")}</p>
    </div>
  </article>;
}

function Pagination({ page, totalPages, onChange }) {
  return <nav className="dm-pagination"><button className="dm-icon-button" disabled={page <= 1} onClick={() => onChange(page - 1)}><ArrowLeft size={17} /></button><span>Page {page} of {totalPages}</span><button className="dm-icon-button" disabled={page >= totalPages} onClick={() => onChange(page + 1)}><ArrowRight size={17} /></button></nav>;
}

function releaseMediaSource(video) {
  if (!video) return;
  video.pause();
  video.removeAttribute("src");
  video.load();
}

function CompareDialog({ group, matchSettings, selectedIds, onToggle, onClose }) {
  const [leftId, setLeftId] = useState(group[0].id);
  const [rightId, setRightId] = useState(group[1].id);
  const [wipe, setWipe] = useState(50);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [leftStart, setLeftStart] = useState(0);
  const [rightStart, setRightStart] = useState(0);
  const [leftSourceEpoch, setLeftSourceEpoch] = useState(0);
  const [rightSourceEpoch, setRightSourceEpoch] = useState(0);
  const [leftTranscodeActive, setLeftTranscodeActive] = useState(false);
  const [rightTranscodeActive, setRightTranscodeActive] = useState(false);
  const [leftReady, setLeftReady] = useState(false);
  const [rightReady, setRightReady] = useState(false);
  const [leftForceTranscode, setLeftForceTranscode] = useState(false);
  const [rightForceTranscode, setRightForceTranscode] = useState(false);
  const [leftResolution, setLeftResolution] = useState({ videoId: null, ready: false, candidates: [], attempt: 0 });
  const [rightResolution, setRightResolution] = useState({ videoId: null, ready: false, candidates: [], attempt: 0 });
  const [pendingPlay, setPendingPlay] = useState(false);
  const [seeking, setSeeking] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const left = group.find((video) => video.id === Number(leftId)) || group[0];
  const right = group.find((video) => video.id === Number(rightId)) || group[1];
  const leftRef = useRef(null);
  const rightRef = useRef(null);
  const stageRef = useRef(null);
  const seekTimerRef = useRef(null);
  const playRequestRef = useRef(0);
  const startingRef = useRef(false);
  const leftPlaybackBase = comparisonPlayback(left);
  const rightPlaybackBase = comparisonPlayback(right);
  const leftPlayback = { ...leftPlaybackBase, transcode: leftPlaybackBase.transcode || leftForceTranscode };
  const rightPlayback = { ...rightPlaybackBase, transcode: rightPlaybackBase.transcode || rightForceTranscode };
  const leftResolutionReady = leftResolution.videoId === left.id && leftResolution.ready;
  const rightResolutionReady = rightResolution.videoId === right.id && rightResolution.ready;
  const leftResolutionValue = leftResolution.candidates[leftResolution.attempt] ?? null;
  const rightResolutionValue = rightResolution.candidates[rightResolution.attempt] ?? null;
  const leftSource = leftPlayback.transcode
    ? leftTranscodeActive && leftResolutionReady ? mediaUrls.transcode(left.id, leftStart, leftResolutionValue) : null
    : mediaUrls.stream(left.id);
  const rightSource = rightPlayback.transcode
    ? rightTranscodeActive && rightResolutionReady ? mediaUrls.transcode(right.id, rightStart, rightResolutionValue) : null
    : mediaUrls.stream(right.id);
  const duration = Math.min(Number(primaryFile(left)?.duration || 0), Number(primaryFile(right)?.duration || 0));

  function pauseBoth() {
    const a = leftRef.current; const b = rightRef.current;
    a?.pause(); b?.pause();
  }
  function localTime(absolute, start, transcoded) {
    return Math.max(0, Number(absolute || 0) - (transcoded ? Number(start || 0) : 0));
  }
  function absoluteTime(video, start, transcoded) {
    return Number(video?.currentTime || 0) + (transcoded ? Number(start || 0) : 0);
  }
  function align(video, absolute, start, transcoded) {
    if (!video || video.readyState < 1) return;
    const target = localTime(absolute, start, transcoded);
    if (Math.abs(Number(video.currentTime || 0) - target) > 0.08) video.currentTime = target;
  }
  function requestPlay() {
    if (seeking) return;
    setPlaybackError("");
    setPendingPlay(true);
    if (leftPlayback.transcode && !leftTranscodeActive) {
      setLeftReady(false);
      setLeftSourceEpoch((value) => value + 1);
      setLeftTranscodeActive(true);
    } else if (!leftPlayback.transcode) {
      setLeftReady(leftRef.current?.readyState >= 3);
    }
    if (rightPlayback.transcode && !rightTranscodeActive) {
      setRightReady(false);
      setRightSourceEpoch((value) => value + 1);
      setRightTranscodeActive(true);
    } else if (!rightPlayback.transcode) {
      setRightReady(rightRef.current?.readyState >= 3);
    }
  }
  function pause() {
    const a = leftRef.current; const b = rightRef.current;
    const target = playing && a ? absoluteTime(a, leftStart, leftPlayback.transcode) : time;
    playRequestRef.current++;
    pauseBoth();
    setTime(target);
    if (leftPlayback.transcode && leftTranscodeActive) {
      releaseMediaSource(a);
      setLeftReady(false);
      setLeftStart(target);
      setLeftTranscodeActive(false);
    }
    if (rightPlayback.transcode && rightTranscodeActive) {
      releaseMediaSource(b);
      setRightReady(false);
      setRightStart(target);
      setRightTranscodeActive(false);
    }
    setPendingPlay(false);
    setPlaying(false);
  }
  function seek(value) {
    const next = Math.max(0, Math.min(duration || 0, Number(value)));
    const resume = playing || pendingPlay;
    playRequestRef.current++;
    pauseBoth();
    setPlaying(false);
    setPendingPlay(resume);
    setTime(next);
    setSeeking(true);
    setLeftReady(false);
    setRightReady(false);
    setPlaybackError("");
    clearTimeout(seekTimerRef.current);
    seekTimerRef.current = setTimeout(() => {
      const a = leftRef.current; const b = rightRef.current;
      if (leftPlayback.transcode) { releaseMediaSource(a); setLeftReady(false); setLeftTranscodeActive(false); }
      else { align(a, next, 0, false); setLeftReady(a?.readyState >= 3); }
      if (rightPlayback.transcode) { releaseMediaSource(b); setRightReady(false); setRightTranscodeActive(false); }
      else { align(b, next, 0, false); setRightReady(b?.readyState >= 3); }
      // Give the browser time to cancel both old HTTP responses so Cove releases their two
      // transcode semaphore slots before the replacement requests are issued.
      seekTimerRef.current = setTimeout(() => {
        if (leftPlayback.transcode) {
          setLeftStart(next);
          if (resume) { setLeftSourceEpoch((value) => value + 1); setLeftTranscodeActive(true); }
        }
        if (rightPlayback.transcode) {
          setRightStart(next);
          if (resume) { setRightSourceEpoch((value) => value + 1); setRightTranscodeActive(true); }
        }
        setSeeking(false);
      }, 75);
    }, 120);
  }
  function markWaiting(side) {
    if (side === "left") setLeftReady(false); else setRightReady(false);
    if (playing || pendingPlay) {
      pauseBoth();
      setPlaying(false);
      setPendingPlay(true);
    }
  }
  function handleLeftTimeUpdate(event) {
    if (!playing) return;
    const absolute = absoluteTime(event.currentTarget, leftStart, leftPlayback.transcode);
    setTime(absolute);
    const other = rightRef.current;
    const otherAbsolute = absoluteTime(other, rightStart, rightPlayback.transcode);
    if (other?.readyState >= 2 && Math.abs(absolute - otherAbsolute) > 0.2) {
      align(other, absolute, rightStart, rightPlayback.transcode);
    }
  }
  function handleMediaError(side) {
    const isLeft = side === "left";
    const playback = isLeft ? leftPlayback : rightPlayback;
    const video = isLeft ? leftRef.current : rightRef.current;
    const start = isLeft ? leftStart : rightStart;
    const absolute = absoluteTime(video, start, playback.transcode);
    if (!playback.transcode) {
      const resume = playing || pendingPlay;
      playRequestRef.current++;
      pauseBoth();
      releaseMediaSource(video);
      setPlaying(false);
      setPendingPlay(resume);
      if (isLeft) {
        setLeftReady(false);
        setLeftStart(absolute);
        setLeftForceTranscode(true);
        setLeftTranscodeActive(resume);
      } else {
        setRightReady(false);
        setRightStart(absolute);
        setRightForceTranscode(true);
        setRightTranscodeActive(resume);
      }
      return;
    }
    const resolution = isLeft ? leftResolution : rightResolution;
    if (resolution.attempt + 1 < resolution.candidates.length) {
      const resume = playing || pendingPlay;
      playRequestRef.current++;
      pauseBoth();
      setPlaying(false);
      setPendingPlay(resume);
      setTime(absolute);
      setPlaybackError("");
      if (isLeft) {
        setLeftReady(false);
        setLeftResolution((current) => ({ ...current, attempt: current.attempt + 1 }));
        setLeftSourceEpoch((value) => value + 1);
      } else {
        setRightReady(false);
        setRightResolution((current) => ({ ...current, attempt: current.attempt + 1 }));
        setRightSourceEpoch((value) => value + 1);
      }
      return;
    }
    pause();
    setPlaybackError(`Video ${isLeft ? "A" : "B"} could not be transcoded. Check Cove's FFmpeg settings.`);
  }
  function moveWipe(event) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect?.width) return;
    setWipe(Math.max(0, Math.min(100, ((event.clientX - rect.left) / rect.width) * 100)));
  }
  function startWipe(event) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    moveWipe(event);
  }
  useEffect(() => {
    pauseBoth();
    playRequestRef.current++;
    setPlaying(false); setPendingPlay(false); setSeeking(false); setTime(0); setLeftStart(0); setRightStart(0); setLeftSourceEpoch(0); setRightSourceEpoch(0); setLeftTranscodeActive(false); setRightTranscodeActive(false);
    setLeftReady(false); setRightReady(false); setLeftForceTranscode(false); setRightForceTranscode(false); setPlaybackError("");
  }, [leftId, rightId]);
  useEffect(() => {
    if (!leftPlayback.transcode) return;
    let cancelled = false;
    setLeftResolution({ videoId: left.id, ready: false, candidates: [], attempt: 0 });
    loadTranscodeResolutions(left.id).then((values) => {
      if (!cancelled) setLeftResolution({ videoId: left.id, ready: true, candidates: transcodeResolutionCandidates(values), attempt: 0 });
    }).catch(() => {
      if (!cancelled) setLeftResolution({ videoId: left.id, ready: true, candidates: [null], attempt: 0 });
    });
    return () => { cancelled = true; };
  }, [left.id, leftPlayback.transcode]);
  useEffect(() => {
    if (!rightPlayback.transcode) return;
    let cancelled = false;
    setRightResolution({ videoId: right.id, ready: false, candidates: [], attempt: 0 });
    loadTranscodeResolutions(right.id).then((values) => {
      if (!cancelled) setRightResolution({ videoId: right.id, ready: true, candidates: transcodeResolutionCandidates(values), attempt: 0 });
    }).catch(() => {
      if (!cancelled) setRightResolution({ videoId: right.id, ready: true, candidates: [null], attempt: 0 });
    });
    return () => { cancelled = true; };
  }, [right.id, rightPlayback.transcode]);
  useEffect(() => {
    if (!pendingPlay || !leftReady || !rightReady || startingRef.current) return;
    const a = leftRef.current; const b = rightRef.current;
    if (!a || !b) return;
    const request = ++playRequestRef.current;
    startingRef.current = true;
    align(a, time, leftStart, leftPlayback.transcode);
    align(b, time, rightStart, rightPlayback.transcode);
    Promise.all([a.play(), b.play()]).then(() => {
      if (request !== playRequestRef.current) return;
      setPendingPlay(false);
      setPlaying(true);
    }).catch((reason) => {
      if (request !== playRequestRef.current) return;
      pauseBoth();
      setPendingPlay(false);
      setPlaying(false);
      setPlaybackError(reason?.message || "The comparison could not start playback.");
    }).finally(() => { startingRef.current = false; });
  }, [pendingPlay, leftReady, rightReady, time, leftStart, rightStart, leftId, rightId]);
  useEffect(() => () => {
    clearTimeout(seekTimerRef.current);
    playRequestRef.current++;
    for (const video of [leftRef.current, rightRef.current]) {
      if (!video) continue;
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }, []);

  return <Modal title="Compare duplicates" onClose={onClose} wide>
    <div className="dm-compare-selects"><label>Video A<select value={left.id} onChange={(event) => { releaseMediaSource(leftRef.current); setLeftTranscodeActive(false); setLeftForceTranscode(false); setLeftId(Number(event.target.value)); }}>{group.filter((video) => video.id !== right.id).map((video) => <option key={video.id} value={video.id}>{video.title || primaryFile(video)?.basename || `Video #${video.id}`}</option>)}</select></label><label>Video B<select value={right.id} onChange={(event) => { releaseMediaSource(rightRef.current); setRightTranscodeActive(false); setRightForceTranscode(false); setRightId(Number(event.target.value)); }}>{group.filter((video) => video.id !== left.id).map((video) => <option key={video.id} value={video.id}>{video.title || primaryFile(video)?.basename || `Video #${video.id}`}</option>)}</select></label></div>
    <div className="dm-compare-stage" ref={stageRef}>
      <video key={`${left.id}-${leftPlayback.transcode ? `${leftStart}-${leftResolutionValue || "source"}-${leftSourceEpoch}` : "direct"}`} ref={leftRef} src={leftSource || undefined} muted playsInline preload={leftPlayback.transcode ? "auto" : "metadata"} onCanPlay={() => setLeftReady(true)} onWaiting={() => markWaiting("left")} onTimeUpdate={handleLeftTimeUpdate} onError={() => handleMediaError("left")} onEnded={() => pause()} />
      <div className="dm-compare-overlay" style={{ clipPath: `inset(0 0 0 ${wipe}%)` }}><video key={`${right.id}-${rightPlayback.transcode ? `${rightStart}-${rightResolutionValue || "source"}-${rightSourceEpoch}` : "direct"}`} ref={rightRef} src={rightSource || undefined} muted playsInline preload={rightPlayback.transcode ? "auto" : "metadata"} onCanPlay={() => setRightReady(true)} onWaiting={() => markWaiting("right")} onError={() => handleMediaError("right")} /></div>
      <span className="dm-label-a">A</span><span className="dm-label-b">B</span>
      <button className="dm-wipe-handle" aria-label="Drag to compare videos" title="Drag to compare" style={{ left: `${wipe}%` }} onPointerDown={startWipe} onPointerMove={(event) => event.currentTarget.hasPointerCapture(event.pointerId) && moveWipe(event)}><span /></button>
    </div>
    {playbackError && <div className="dm-alert dm-error"><AlertTriangle size={16} /><span>{playbackError}</span></div>}
    <div className="dm-compare-controls"><button className="dm-icon-button" disabled={seeking} onClick={() => playing || pendingPlay ? pause() : requestPlay()}>{playing ? <Pause size={18} /> : pendingPlay || seeking ? <Loader2 className="dm-spin" size={18} /> : <Play size={18} />}</button><span>{formatDuration(time)}</span><input type="range" min="0" max={Math.max(duration, 1)} step="0.1" value={Math.min(time, duration || 1)} onChange={(event) => seek(event.target.value)} /><span>{formatDuration(duration)}</span>{seeking ? <span>Setting seek point</span> : pendingPlay && (!leftReady || !rightReady) && <span>Preparing playback</span>}</div>
    {matchSettings.matchType === "phash" && <div className="dm-compare-phash"><PhashSummary left={left} right={right} threshold={matchSettings.phashDistance} /></div>}
    <div className="dm-compare-details"><CompareDetails label="A" video={left} selected={selectedIds.has(left.id)} onToggle={() => onToggle(left.id)} /><CompareDetails label="B" video={right} selected={selectedIds.has(right.id)} onToggle={() => onToggle(right.id)} /></div>
  </Modal>;
}

function CompareDetails({ label, video, selected, onToggle }) {
  const file = primaryFile(video);
  return <div><strong>{label}: {video.title || file?.basename || `Video #${video.id}`}</strong><p>{file?.width || 0}x{file?.height || 0} · {file?.videoCodec || "unknown"} · {Math.round(Number(file?.bitRate || 0) / 1000)} kbps · {formatBytes(file?.size)} · {metadataCount(video)} metadata</p><p className="dm-file-path" title={file?.path}>{displayPath(file?.path)}</p><label className="dm-compare-delete"><input type="checkbox" checked={selected} onChange={onToggle} />Mark for deletion</label></div>;
}

function PhashSummary({ left, right, threshold }) {
  if (!left || !right) return null;
  const comparison = phashComparison(left, right, threshold);
  const rows = [
    ["pHash distance", comparison.phash],
    ["Size difference", comparison.size],
    ["Resolution", comparison.resolution],
    ["Codec", comparison.codec],
    ["Duration", comparison.duration],
  ];
  return <div className="dm-phash-summary">{rows.map(([label, result]) => <div key={label} className={result.matches ? "dm-match" : "dm-mismatch"}>{result.matches ? <Check size={13} /> : <X size={13} />}<span>{label}: {result.value}</span></div>)}</div>;
}

function DeleteDialog({ summary, defaults, onCancel, onConfirm }) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [deleteGenerated, setDeleteGenerated] = useState(true);
  const [copyMetadata, setCopyMetadata] = useState(defaults.copyMissingMetadata);
  const [overwriteMetadata, setOverwriteMetadata] = useState(defaults.overwriteConflictingMetadata);
  return <Modal title="Delete selected duplicates" onClose={onCancel}>
    <p className="dm-dialog-message">Delete {summary.videos} video records affecting {summary.files} files ({formatBytes(summary.bytes)})? At least one video will remain in each affected group.</p>
    <label className="dm-checkbox-row"><input type="checkbox" checked={deleteFiles} onChange={(event) => setDeleteFiles(event.target.checked)} /><span><strong>Delete source file from disk (this will permanently remove the file)</strong><small>This cannot be undone.</small></span></label>
    <label className="dm-checkbox-row"><input type="checkbox" checked={deleteGenerated} onChange={(event) => setDeleteGenerated(event.target.checked)} /><span><strong>Delete generated files</strong><small>Remove Cove thumbnails, previews, sprites, and other generated artifacts.</small></span></label>
    <label className="dm-checkbox-row"><input type="checkbox" checked={copyMetadata} onChange={(event) => setCopyMetadata(event.target.checked)} /><span><strong>Copy missing metadata from deleted files</strong><small>Merge titles, editable metadata, relationships, and markers before deletion.</small></span></label>
    <label className="dm-checkbox-row"><input type="checkbox" checked={overwriteMetadata} disabled={!copyMetadata} onChange={(event) => setOverwriteMetadata(event.target.checked)} /><span><strong>Overwrite conflicting metadata</strong><small>Prefer metadata from deleted files when both videos have a value.</small></span></label>
    <div className="dm-dialog-actions"><button className="dm-secondary" onClick={onCancel}>Cancel</button><button className="dm-danger" onClick={() => onConfirm({ deleteFiles, deleteGenerated, copyMetadata, overwriteConflictingMetadata: copyMetadata && overwriteMetadata })}><Trash2 size={16} />Delete {summary.videos} videos</button></div>
  </Modal>;
}

function FolderScopeControl({ settings, onChange, onPick, settingsView = false }) {
  const setMode = (folderMode) => onChange(folderMode === "all" ? { folderMode, includedPaths: [] } : { folderMode });
  return <div className={`dm-folder-scope ${settingsView ? "dm-folder-scope-settings" : ""}`}>
    <div className="dm-folder-modes" role="group" aria-label="Folder mode">
      {[['all', 'All'], ['include', 'Include'], ['exclude', 'Exclude']].map(([mode, label]) => <button key={mode} type="button" className={settings.folderMode === mode ? "dm-folder-mode-active" : ""} aria-pressed={settings.folderMode === mode} onClick={() => setMode(mode)}>{label}</button>)}
    </div>
    <button type="button" className="dm-secondary dm-folder-button" disabled={settings.folderMode === "all"} onClick={onPick}><Folder size={16} />{settings.folderMode === "all" ? "All folders" : settings.includedPaths.length ? `${settings.includedPaths.length} folders` : "Choose folders"}</button>
  </div>;
}

function FolderDialog({ mode, selected, onCancel, onApply }) {
  const [paths, setPaths] = useState([...selected]);
  const [roots, setRoots] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => { loadFolders().then(setRoots).catch((reason) => setError(reason.message || "Could not load folders.")).finally(() => setLoading(false)); }, []);
  function toggle(path) { setPaths((values) => values.includes(path) ? values.filter((value) => value !== path) : [...values, path]); }
  return <Modal title={`${mode === "exclude" ? "Exclude" : "Include"} folders`} onClose={onCancel}>
    <div className="dm-folder-heading"><div><strong>{mode === "exclude" ? "Excluded folders" : "Included folders"}</strong><p>Select one or more library folders.</p></div>{paths.length > 0 && <button onClick={() => setPaths([])}>Clear</button>}</div>
    <div className="dm-folder-tree">{loading ? <p><Loader2 className="dm-spin" size={15} />Loading folders</p> : error ? <p className="dm-folder-error">{error}</p> : roots.map((entry) => <FolderNode key={entry.path} entry={entry} depth={0} selected={paths} onToggle={toggle} />)}</div>
    <div className="dm-dialog-actions"><button className="dm-secondary" onClick={onCancel}>Cancel</button><button className="dm-primary" onClick={() => onApply(paths)}><Check size={16} />Apply</button></div>
  </Modal>;
}

function FolderNode({ entry, depth, selected, onToggle }) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState(null);
  const [loading, setLoading] = useState(false);
  function toggleExpanded() {
    const next = !expanded;
    setExpanded(next);
    if (next && entry.hasChildren && children === null) {
      setLoading(true);
      loadFolders(entry.path).then(setChildren).catch(() => setChildren([])).finally(() => setLoading(false));
    }
  }
  return <div className="dm-folder-node">
    <div className="dm-folder-row" style={{ paddingLeft: `${depth * 16 + 4}px` }}>
      {entry.hasChildren ? <button aria-label={expanded ? "Collapse folder" : "Expand folder"} onClick={toggleExpanded}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="dm-folder-spacer" />}
      <label><input type="checkbox" checked={selected.includes(entry.path)} onChange={() => onToggle(entry.path)} /><span title={entry.path}>{entry.name || entry.path}</span></label>
    </div>
    {expanded && (loading ? <p className="dm-folder-child-status" style={{ paddingLeft: `${depth * 16 + 38}px` }}>Loading...</p> : (children || []).map((child) => <FolderNode key={child.path} entry={child} depth={depth + 1} selected={selected} onToggle={onToggle} />))}
  </div>;
}

function PageSizeControl({ value, onChange, settingsLabel = false }) {
  const presets = [10, 25, 50, 100];
  const custom = !presets.includes(Number(value));
  return <div className={`dm-page-size ${settingsLabel ? "dm-page-size-settings" : ""}`}>
    {settingsLabel && <span>Groups per page</span>}
    <select aria-label="Groups per page" value={custom ? "custom" : String(value)} onChange={(event) => onChange(event.target.value === "custom" ? 250 : Number(event.target.value))}>
      {presets.map((size) => <option key={size} value={size}>{size}{settingsLabel ? "" : " groups"}</option>)}
      <option value="custom">Custom</option>
    </select>
    {custom && <input aria-label="Custom groups per page" type="number" min="1" max="10000" value={value} onChange={(event) => onChange(Math.max(1, Math.min(10000, Number(event.target.value) || 1)))} />}
  </div>;
}

function DurationInput({ label, value, onChange }) {
  const [text, setText] = useState(formatDurationInput(value));
  const [invalid, setInvalid] = useState(false);
  useEffect(() => { setText(formatDurationInput(value)); }, [value]);
  function commit() {
    const parsed = parseDurationInput(text);
    if (parsed === null) { setInvalid(true); return; }
    setInvalid(false);
    onChange(parsed);
    setText(formatDurationInput(parsed));
  }
  return <label className={invalid ? "dm-duration-invalid" : ""}><span>{label}</span><input type="text" inputMode="numeric" value={text} placeholder="0:00" title="Seconds, MM:SS, or HH:MM:SS" onChange={(event) => setText(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }} /></label>;
}

function Modal({ title, onClose, wide, children }) {
  return <div className="dm-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className={`dm-modal ${wide ? "dm-modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button className="dm-icon-button" onClick={onClose}><X size={18} /></button></header>{children}</div></div>;
}

export function DuplicateManagerSettingsPanel() {
  const [settings, setSettings] = useState(normalizeSettings(DEFAULT_SETTINGS));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [folderOpen, setFolderOpen] = useState(false);
  useEffect(() => { loadSettings().then((value) => setSettings(normalizeSettings(value))).catch((reason) => setMessage(reason.message)).finally(() => setLoading(false)); }, []);
  function update(patch) { setSettings((current) => normalizeSettings({ ...current, ...patch })); }
  function moveRule(index, delta) { const rules = [...settings.keeperRules]; const target = index + delta; if (target < 0 || target >= rules.length) return; [rules[index], rules[target]] = [rules[target], rules[index]]; update({ keeperRules: rules }); }
  function removeRule(index) { update({ keeperRules: settings.keeperRules.filter((_, itemIndex) => itemIndex !== index) }); }
  async function save() { setSaving(true); setMessage(""); try { setSettings(normalizeSettings(await saveSettings(settings))); setMessage("Settings saved."); } catch (reason) { setMessage(reason.message); } finally { setSaving(false); } }
  if (loading) return <div className="dm-settings-loading"><Loader2 className="dm-spin" />Loading Duplicate Manager settings</div>;
  const availableRules = Object.keys(RULE_LABELS).filter((rule) => !settings.keeperRules.includes(rule));
  return <div className="dm-settings">
    <div className="dm-settings-heading"><div><h3><Settings2 size={19} />Duplicate Manager</h3><p>Defaults used when the improved Duplicate Finder opens.</p></div><button className="dm-primary" disabled={saving} onClick={save}>{saving ? <Loader2 className="dm-spin" size={16} /> : <Save size={16} />}Save</button></div>
    <div className="dm-settings-grid"><label><span>Default match type</span><select value={settings.matchType} onChange={(event) => update({ matchType: event.target.value })}><option value="fingerprint">Exact fingerprint</option><option value="phash">Visual pHash</option><option value="title">Same title</option><option value="remoteid">Same remote ID</option></select></label><label><span>Exact algorithm</span><select value={settings.fingerprintAlgorithm} onChange={(event) => update({ fingerprintAlgorithm: event.target.value })}><option value="any">MD5 or OSHash</option><option value="md5">MD5</option><option value="oshash">OSHash</option></select></label><label><span>Maximum pHash distance</span><input type="number" min="0" max="64" value={settings.phashDistance} onChange={(event) => update({ phashDistance: Number(event.target.value) })} /></label><label><span>Duration delta</span><input type="number" min="0" value={settings.maxDurationDelta} onChange={(event) => update({ maxDurationDelta: Number(event.target.value) })} /></label><DurationInput label="Minimum length" value={settings.minimumDuration} onChange={(minimumDuration) => update({ minimumDuration })} /><PageSizeControl settingsLabel value={settings.pageSize} onChange={(pageSize) => update({ pageSize })} /></div>
    <section><h4>Preferred codecs</h4><p>Best to worst, separated by commas.</p><input value={settings.preferredCodecs.join(", ")} onChange={(event) => update({ preferredCodecs: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} /></section>
    <section><h4>Default folder scope</h4><p>Search all folders, only selected folders, or everything except selected folders.</p><FolderScopeControl settings={settings} onChange={update} onPick={() => setFolderOpen(true)} settingsView /></section>
    <section><h4>Metadata transfer</h4><p>Defaults used when confirming bulk deletion.</p><label className="dm-checkbox-row"><input type="checkbox" checked={settings.copyMissingMetadata} onChange={(event) => update({ copyMissingMetadata: event.target.checked })} /><span><strong>Copy missing metadata from deleted files</strong><small>Merge missing editable metadata, relationships, ratings, markers, and cover artwork into the keeper.</small></span></label><label className="dm-checkbox-row"><input type="checkbox" checked={settings.overwriteConflictingMetadata} disabled={!settings.copyMissingMetadata} onChange={(event) => update({ overwriteConflictingMetadata: event.target.checked })} /><span><strong>Overwrite conflicting metadata</strong><small>Prefer metadata from deleted files when both videos have a value.</small></span></label></section>
    <section><h4>Keeper priority</h4><p>Rules are evaluated top to bottom. The first difference determines the recommended keeper.</p><div className="dm-rule-list">{settings.keeperRules.map((rule, index) => <div key={rule}><span>{index + 1}. {RULE_LABELS[rule]}</span><div><button className="dm-icon-button" disabled={index === 0} onClick={() => moveRule(index, -1)}><ArrowUp size={15} /></button><button className="dm-icon-button" disabled={index === settings.keeperRules.length - 1} onClick={() => moveRule(index, 1)}><ArrowDown size={15} /></button><button className="dm-icon-button" onClick={() => removeRule(index)}><X size={15} /></button></div></div>)}</div>{availableRules.length > 0 && <select value="" onChange={(event) => event.target.value && update({ keeperRules: [...settings.keeperRules, event.target.value] })}><option value="">Add tie-break rule...</option>{availableRules.map((rule) => <option key={rule} value={rule}>{RULE_LABELS[rule]}</option>)}</select>}</section>
    {message && <div className={`dm-alert ${message === "Settings saved." ? "dm-success" : "dm-error"}`}>{message}</div>}
    {folderOpen && <FolderDialog mode={settings.folderMode} selected={settings.includedPaths} onCancel={() => setFolderOpen(false)} onApply={(includedPaths) => { update({ includedPaths }); setFolderOpen(false); }} />}
  </div>;
}

export default { components: { DuplicateManagerPage, DuplicateManagerSettingsPanel } };

function groupKey(group) {
  return (group || []).map((video) => Number(video.id)).sort((a, b) => a - b).join("-");
}
