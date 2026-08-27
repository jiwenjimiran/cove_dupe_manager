using System.Collections.Concurrent;
using System.Globalization;
using System.Reflection;
using Cove.Core.Entities;
using Cove.Core.Interfaces;
using Cove.Data;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Cove.DuplicateManager;

public sealed record VideoDeletionJobItem(int TargetId, int SourceId);

public sealed record VideoDeletionJobRequest(
    List<VideoDeletionJobItem> Items,
    bool CopyMetadata,
    bool OverwriteConflictingMetadata,
    bool DeleteFiles,
    bool DeleteGenerated);

public sealed record ImageDeletionJobRequest(
    int TargetImageId,
    List<int> SourceImageIds,
    List<int> FileIds);

public sealed record DuplicateDeletionFailure(int SourceId, string Stage, string Message);
public sealed record DuplicateDeletionWarning(int SourceId, string Message);

public sealed record DuplicateDeletionJobSnapshot(
    string OperationId,
    string? CoreJobId,
    string MediaType,
    string Status,
    string Stage,
    int Total,
    int Processed,
    int? CurrentSourceId,
    int? CurrentTargetId,
    IReadOnlyList<int> CompletedIds,
    IReadOnlyList<DuplicateDeletionFailure> Failed,
    IReadOnlyList<DuplicateDeletionWarning> Warnings,
    string? Error);

public sealed class DuplicateDeletionJobService(
    IServiceScopeFactory scopeFactory,
    IJobService jobService,
    ILogger<DuplicateDeletionJobService> logger)
{
    private const int MaximumVideoItems = 10_000;
    private readonly ConcurrentDictionary<string, MutableJobState> _states = new(StringComparer.Ordinal);

    public DuplicateDeletionJobSnapshot StartVideoJob(VideoDeletionJobRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        var items = NormalizeVideoItems(request.Items);
        var operationId = Guid.NewGuid().ToString("N");
        var state = new MutableJobState(operationId, "video", items.Count);
        _states[operationId] = state;

        try
        {
            var coreJobId = jobService.Enqueue(
                "ext:duplicate-manager-delete-videos",
                $"[Duplicate Manager] Copy metadata and delete {items.Count} duplicate video{(items.Count == 1 ? string.Empty : "s")}",
                (progress, ct) => RunVideoJobAsync(operationId, items, request, progress, ct),
                exclusive: true);
            state.AttachCoreJob(coreJobId);
            return state.Snapshot();
        }
        catch
        {
            _states.TryRemove(operationId, out _);
            throw;
        }
    }

    public DuplicateDeletionJobSnapshot StartImageJob(ImageDeletionJobRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.TargetImageId <= 0)
            throw new ArgumentException("A valid keeper image is required.");
        var sourceIds = (request.SourceImageIds ?? []).Where(id => id > 0 && id != request.TargetImageId).Distinct().ToList();
        var fileIds = (request.FileIds ?? []).Where(id => id > 0).Distinct().ToList();
        if (sourceIds.Count == 0 && fileIds.Count == 0)
            throw new ArgumentException("At least one duplicate image or image file is required.");

        var normalized = request with { SourceImageIds = sourceIds, FileIds = fileIds };
        var operationId = Guid.NewGuid().ToString("N");
        var state = new MutableJobState(operationId, "image", 1);
        _states[operationId] = state;

        try
        {
            var coreJobId = jobService.Enqueue(
                "ext:duplicate-manager-delete-images",
                "[Duplicate Manager] Copy metadata and clean a duplicate image group",
                (progress, ct) => RunImageJobAsync(operationId, normalized, progress, ct),
                exclusive: true);
            state.AttachCoreJob(coreJobId);
            return state.Snapshot();
        }
        catch
        {
            _states.TryRemove(operationId, out _);
            throw;
        }
    }

    public DuplicateDeletionJobSnapshot? Get(string operationId, string mediaType)
        => _states.TryGetValue(operationId, out var state)
            && string.Equals(state.MediaType, mediaType, StringComparison.Ordinal)
                ? state.Snapshot()
                : null;

    private static List<VideoDeletionJobItem> NormalizeVideoItems(IEnumerable<VideoDeletionJobItem>? requested)
    {
        var items = (requested ?? [])
            .Where(item => item.TargetId > 0 && item.SourceId > 0 && item.TargetId != item.SourceId)
            .GroupBy(item => item.SourceId)
            .Select(group => group.First())
            .ToList();
        if (items.Count == 0)
            throw new ArgumentException("At least one valid duplicate video is required.");
        if (items.Count > MaximumVideoItems)
            throw new ArgumentException($"A deletion job can contain at most {MaximumVideoItems} videos.");
        return items;
    }

    private async Task RunVideoJobAsync(
        string operationId,
        IReadOnlyList<VideoDeletionJobItem> items,
        VideoDeletionJobRequest request,
        IJobProgress progress,
        CancellationToken ct)
    {
        var state = _states[operationId];
        state.Start();
        try
        {
            for (var index = 0; index < items.Count; index++)
            {
                ct.ThrowIfCancellationRequested();
                var item = items[index];
                state.BeginItem(item.SourceId, item.TargetId, request.CopyMetadata ? "metadata" : "engagement");
                progress.Report((double)index / items.Count, $"Preparing video {index + 1} of {items.Count}");

                try
                {
                    await using var scope = scopeFactory.CreateAsyncScope();
                    var warnings = await ProcessVideoAsync(scope.ServiceProvider, item, request, state, ct);
                    state.CompleteItem(item.SourceId, warnings);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    logger.LogError(ex, "Duplicate Manager could not delete source video {SourceId} into keeper {TargetId}", item.SourceId, item.TargetId);
                    state.FailItem(item.SourceId, ex is DuplicateDeletionStageException stage ? stage.Stage : state.Stage, ex.Message);
                }

                progress.Report((double)(index + 1) / items.Count, $"Processed video {index + 1} of {items.Count}");
            }

            state.Finish();
            if (state.FailedCount > 0)
            {
                progress.Report(1, "Duplicate deletion completed with errors");
                throw new InvalidOperationException($"{state.FailedCount} duplicate video deletion{(state.FailedCount == 1 ? string.Empty : "s")} failed.");
            }
            progress.Report(1, "Duplicate deletion complete");
        }
        catch (OperationCanceledException)
        {
            state.Cancel();
            throw;
        }
        catch (Exception ex)
        {
            if (!string.Equals(state.Status, "partial", StringComparison.Ordinal))
                state.Fatal(ex.Message);
            throw;
        }
    }

    private async Task RunImageJobAsync(string operationId, ImageDeletionJobRequest request, IJobProgress progress, CancellationToken ct)
    {
        var state = _states[operationId];
        state.Start();
        state.BeginItem(request.TargetImageId, request.TargetImageId, "metadata");
        try
        {
            progress.Report(0, "Copying duplicate image metadata");
            await using var scope = scopeFactory.CreateAsyncScope();
            await ProcessImageGroupAsync(scope.ServiceProvider, request, state, ct);
            state.CompleteItem(request.TargetImageId, []);
            state.Finish();
            progress.Report(1, "Duplicate image cleanup complete");
        }
        catch (OperationCanceledException)
        {
            state.Cancel();
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Duplicate Manager could not clean image group for keeper {TargetImageId}", request.TargetImageId);
            state.FailItem(request.TargetImageId, ex is DuplicateDeletionStageException stage ? stage.Stage : state.Stage, ex.Message);
            state.Finish();
            progress.Report(1, "Duplicate image cleanup completed with errors");
            throw;
        }
    }

    private static async Task<List<string>> ProcessVideoAsync(
        IServiceProvider services,
        VideoDeletionJobItem item,
        VideoDeletionJobRequest request,
        MutableJobState state,
        CancellationToken ct)
    {
        var db = services.GetRequiredService<CoveContext>();
        var blobService = services.GetService<IBlobService>();
        var streamService = services.GetService<IStreamService>();
        var tagProvenanceService = services.GetService<ITagProvenanceService>();
        var records = await db.Videos
            .Include(video => video.Files)
            .Include(video => video.VideoTags)
            .Include(video => video.VideoPerformers)
            .Include(video => video.VideoGalleries)
            .Include(video => video.Urls)
            .Include(video => video.RemoteIds)
            .Include(video => video.GroupItems)
            .Where(video => video.Id == item.TargetId || video.Id == item.SourceId)
            .ToListAsync(ct);
        var target = records.SingleOrDefault(video => video.Id == item.TargetId)
            ?? throw new DuplicateDeletionStageException("metadata", $"Keeper video {item.TargetId} no longer exists.");
        var source = records.SingleOrDefault(video => video.Id == item.SourceId);
        if (source is null)
            return [];

        var warnings = new List<string>();
        var previousTargetTagIds = target.VideoTags.Select(row => row.TagId).ToArray();
        if (request.CopyMetadata)
        {
            state.SetStage("metadata");
            await CopyVideoMetadataAsync(db, blobService, streamService, target, source, request.OverwriteConflictingMetadata, warnings, ct);
            if (tagProvenanceService is not null)
                await tagProvenanceService.SyncTagSetAsync(
                    AffinityHostType.Video,
                    target.Id,
                    previousTargetTagIds,
                    target.VideoTags.Select(row => row.TagId).ToArray(),
                    cancellationToken: ct);
        }
        else
        {
            await RemoveSourceOnlyMetadataAsync(db, source.Id, ct);
        }

        state.SetStage("engagement");
        await MergeEngagementAsync(
            db,
            AffinityHostType.Video,
            RatingHostType.Video,
            InteractionHostType.Video,
            target.Id,
            source.Id,
            request.OverwriteConflictingMetadata,
            ct);
        await db.SaveChangesAsync(ct);

        state.SetStage("deletion");
        if (request.DeleteFiles)
            await DeleteVideoFilesAsync(db, source, ct);
        if (request.DeleteGenerated)
        {
            await InvokeThumbnailServiceAsync(services, "DeleteVideoGeneratedFilesAsync", source.Id, ct);
            if (!string.IsNullOrWhiteSpace(source.ImageBlobId))
                await InvokeThumbnailServiceAsync(services, "DeleteBlobGeneratedFilesAsync", source.ImageBlobId, ct);
        }

        var sourceBlobId = source.ImageBlobId;
        if (tagProvenanceService is not null)
            await tagProvenanceService.RemoveForHostAsync(AffinityHostType.Video, source.Id, ct);
        db.CustomFieldValues.RemoveRange(await db.CustomFieldValues
            .Where(value => value.EntityType == CustomFieldEntityTypes.Video && value.EntityId == source.Id)
            .ToListAsync(ct));
        db.VideoFiles.RemoveRange(source.Files);
        db.Videos.Remove(source);
        await db.SaveChangesAsync(ct);

        if (blobService is not null && !string.IsNullOrWhiteSpace(sourceBlobId))
            await blobService.DeleteBlobAsync(sourceBlobId, ct);
        return warnings;
    }

    private static async Task CopyVideoMetadataAsync(
        CoveContext db,
        IBlobService? blobService,
        IStreamService? streamService,
        Video target,
        Video source,
        bool overwrite,
        List<string> warnings,
        CancellationToken ct)
    {
        target.Title = Pick(target.Title, source.Title, overwrite);
        target.Code = Pick(target.Code, source.Code, overwrite);
        target.Details = Pick(target.Details, source.Details, overwrite);
        target.Director = Pick(target.Director, source.Director, overwrite);
        target.Date = Pick(target.Date, source.Date, overwrite);
        target.StudioId = Pick(target.StudioId, source.StudioId, overwrite);
        target.Captions = Pick(target.Captions, source.Captions, overwrite);
        if (overwrite)
        {
            target.Organized = source.Organized;
            target.IsVr = source.IsVr;
        }

        AddMissing(target.Urls, source.Urls, row => row.Url, row => new VideoUrl { VideoId = target.Id, Url = row.Url }, StringComparer.OrdinalIgnoreCase);
        AddMissing(target.VideoTags, source.VideoTags, row => row.TagId, row => new VideoTag { VideoId = target.Id, TagId = row.TagId });
        AddMissing(target.VideoPerformers, source.VideoPerformers, row => row.PerformerId, row => new VideoPerformer { VideoId = target.Id, PerformerId = row.PerformerId });
        AddMissing(target.VideoGalleries, source.VideoGalleries, row => row.GalleryId, row => new VideoGallery { VideoId = target.Id, GalleryId = row.GalleryId });
        AddMissing(target.RemoteIds, source.RemoteIds, row => $"{row.Endpoint}\u001f{row.RemoteId}", row => new VideoRemoteId { VideoId = target.Id, Endpoint = row.Endpoint, RemoteId = row.RemoteId }, StringComparer.OrdinalIgnoreCase);

        var existingGroupIds = target.GroupItems
            .Where(row => row.Kind == GroupItemKind.Video)
            .Select(row => row.GroupId)
            .ToHashSet();
        foreach (var sourceGroup in source.GroupItems.Where(row => row.Kind == GroupItemKind.Video))
        {
            if (!existingGroupIds.Add(sourceGroup.GroupId))
                continue;
            target.GroupItems.Add(new GroupItem
            {
                GroupId = sourceGroup.GroupId,
                OrderIndex = sourceGroup.OrderIndex,
                Kind = GroupItemKind.Video,
                HostType = "video",
                HostId = target.Id,
                VideoId = target.Id,
            });
        }

        await MergeCustomFieldsAsync(db, CustomFieldEntityTypes.Video, target.Id, source.Id, overwrite, ct);
        await MergeSegmentsAsync(db, target.Id, source.Id, ct);

        if (string.IsNullOrWhiteSpace(target.ImageBlobId) || overwrite)
        {
            try
            {
                Stream? coverStream = null;
                string? coverContentType = null;
                if (blobService is not null && !string.IsNullOrWhiteSpace(source.ImageBlobId))
                {
                    var blob = await blobService.GetBlobAsync(source.ImageBlobId, ct);
                    if (blob is not null)
                    {
                        coverStream = blob.Value.Stream;
                        coverContentType = blob.Value.ContentType;
                    }
                }
                else if (streamService is not null)
                {
                    var screenshot = await streamService.GetVideoScreenshot(source.Id, null, ct);
                    if (screenshot is not null)
                    {
                        coverStream = screenshot.Value.stream;
                        coverContentType = screenshot.Value.contentType;
                    }
                }

                if (blobService is not null && coverStream is not null && !string.IsNullOrWhiteSpace(coverContentType))
                {
                    await using (coverStream)
                        target.ImageBlobId = await blobService.StoreBlobAsync(coverStream, coverContentType, ct);
                }
                else
                    warnings.Add($"Cover artwork could not be copied to video {target.Id}.");
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                warnings.Add($"Cover artwork could not be copied to video {target.Id}: {ex.Message}");
            }
        }
    }

    private static async Task RemoveSourceOnlyMetadataAsync(CoveContext db, int sourceId, CancellationToken ct)
    {
        db.Segments.RemoveRange(await db.Segments
            .Where(segment => segment.HostType == SegmentHostType.Video && segment.HostId == sourceId)
            .ToListAsync(ct));
    }

    private static async Task MergeCustomFieldsAsync(CoveContext db, string entityType, int targetId, int sourceId, bool overwrite, CancellationToken ct)
    {
        var values = await db.CustomFieldValues
            .Where(value => value.EntityType == entityType && (value.EntityId == targetId || value.EntityId == sourceId))
            .ToListAsync(ct);
        var targetGroups = values.Where(value => value.EntityId == targetId).GroupBy(value => value.DefinitionId).ToDictionary(group => group.Key, group => group.ToList());
        foreach (var sourceGroup in values.Where(value => value.EntityId == sourceId).GroupBy(value => value.DefinitionId))
        {
            if (!targetGroups.TryGetValue(sourceGroup.Key, out var existing) || overwrite)
            {
                if (existing is not null)
                    db.CustomFieldValues.RemoveRange(existing);
                db.CustomFieldValues.AddRange(sourceGroup.Select(value => new CustomFieldValue
                {
                    DefinitionId = value.DefinitionId,
                    EntityType = entityType,
                    EntityId = targetId,
                    Position = value.Position,
                    TextValue = value.TextValue,
                    NumberValue = value.NumberValue,
                    BoolValue = value.BoolValue,
                    DateValue = value.DateValue,
                    TimestampValue = value.TimestampValue,
                    IntegerValue = value.IntegerValue,
                }));
            }
        }
        db.CustomFieldValues.RemoveRange(values.Where(value => value.EntityId == sourceId));
    }

    private static async Task MergeSegmentsAsync(CoveContext db, int targetId, int sourceId, CancellationToken ct)
    {
        var targetKeys = (await db.Segments.AsNoTracking()
            .Where(segment => segment.HostType == SegmentHostType.Video && segment.HostId == targetId)
            .ToListAsync(ct))
            .Select(SegmentKey)
            .ToHashSet(StringComparer.Ordinal);
        foreach (var segment in await db.Segments
            .Where(segment => segment.HostType == SegmentHostType.Video && segment.HostId == sourceId)
            .ToListAsync(ct))
        {
            if (targetKeys.Add(SegmentKey(segment)))
                segment.HostId = targetId;
            else
                db.Segments.Remove(segment);
        }
    }

    private static string SegmentKey(Segment segment)
        => string.Join("|",
            segment.StartSec.ToString("R", CultureInfo.InvariantCulture),
            segment.EndSec?.ToString("R", CultureInfo.InvariantCulture) ?? string.Empty,
            segment.TagId?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
            segment.Kind ?? string.Empty,
            segment.RefId?.ToString(CultureInfo.InvariantCulture) ?? string.Empty,
            segment.Title ?? string.Empty);

    private static async Task MergeEngagementAsync(
        CoveContext db,
        AffinityHostType affinityType,
        RatingHostType ratingType,
        InteractionHostType interactionType,
        int targetId,
        int sourceId,
        bool overwriteRatings,
        CancellationToken ct)
    {
        var targets = await db.UserEntityAffinities
            .Where(row => row.HostType == affinityType && row.HostId == targetId)
            .ToDictionaryAsync(row => row.UserId, ct);
        foreach (var source in await db.UserEntityAffinities
            .Where(row => row.HostType == affinityType && row.HostId == sourceId)
            .ToListAsync(ct))
        {
            if (targets.TryGetValue(source.UserId, out var target))
            {
                target.LikeCount += source.LikeCount;
                target.DerivedLikeCount += source.DerivedLikeCount;
                target.ViewCount += source.ViewCount;
                target.CompleteCount += source.CompleteCount;
                target.TotalConsumedSec += source.TotalConsumedSec;
                target.InteractionCount += source.InteractionCount;
                target.PageVisitCount += source.PageVisitCount;
                target.OpenDetailCount += source.OpenDetailCount;
                target.IsFavorite |= source.IsFavorite;
                target.IsBookmarked |= source.IsBookmarked;
                target.FavoritedAt = Earlier(target.FavoritedAt, source.FavoritedAt);
                target.LastConsumedAt = Later(target.LastConsumedAt, source.LastConsumedAt);
                target.LastInteractedAt = Later(target.LastInteractedAt, source.LastInteractedAt);
                target.UpdatedAt = DateTime.UtcNow;
                db.UserEntityAffinities.Remove(source);
            }
            else
            {
                source.HostId = targetId;
                source.UpdatedAt = DateTime.UtcNow;
                targets[source.UserId] = source;
            }
        }

        var targetRatings = (await db.Ratings
            .Where(row => row.HostType == ratingType && row.HostId == targetId)
            .ToListAsync(ct))
            .ToDictionary(row => (row.UserId, row.Aspect));
        foreach (var source in await db.Ratings
            .Where(row => row.HostType == ratingType && row.HostId == sourceId)
            .ToListAsync(ct))
        {
            if (targetRatings.TryGetValue((source.UserId, source.Aspect), out var target))
            {
                if (overwriteRatings)
                {
                    target.Value = source.Value;
                    target.UpdatedAt = DateTime.UtcNow;
                }
                db.Ratings.Remove(source);
            }
            else
            {
                source.HostId = targetId;
                source.UpdatedAt = DateTime.UtcNow;
                targetRatings[(source.UserId, source.Aspect)] = source;
            }
        }

        var targetBookmarkUsers = (await db.UserBookmarks
            .Where(row => row.HostType == affinityType && row.HostId == targetId)
            .Select(row => row.UserId)
            .ToListAsync(ct))
            .ToHashSet();
        foreach (var source in await db.UserBookmarks
            .Where(row => row.HostType == affinityType && row.HostId == sourceId)
            .ToListAsync(ct))
        {
            if (targetBookmarkUsers.Add(source.UserId))
                source.HostId = targetId;
            else
                db.UserBookmarks.Remove(source);
        }

        await db.Interactions
            .Where(row => row.HostType == interactionType && row.HostId == sourceId)
            .ExecuteUpdateAsync(setters => setters.SetProperty(row => row.HostId, targetId), ct);
    }

    private static async Task DeleteVideoFilesAsync(CoveContext db, Video source, CancellationToken ct)
    {
        var candidates = new List<FileCleanupTarget>();
        foreach (var file in source.Files)
        {
            if (string.IsNullOrWhiteSpace(file.Path))
                continue;
            var retained = await db.VideoFiles.AsNoTracking()
                .AnyAsync(other => other.Id != file.Id && other.Path == file.Path && other.VideoId != source.Id, ct);
            if (!retained)
                candidates.Add(new FileCleanupTarget(file.Id, file.Path, file.Size));
        }
        var cleanup = PermanentFileCleanup.Delete(candidates);
        if (cleanup.Failed.Count > 0)
            throw new DuplicateDeletionStageException("deletion", string.Join("; ", cleanup.Failed.Select(failure => failure.Error)));
    }

    private static async Task ProcessImageGroupAsync(IServiceProvider services, ImageDeletionJobRequest request, MutableJobState state, CancellationToken ct)
    {
        var db = services.GetRequiredService<CoveContext>();
        var tagProvenanceService = services.GetService<ITagProvenanceService>();
        if (!await db.Images.AnyAsync(image => image.Id == request.TargetImageId, ct))
            throw new DuplicateDeletionStageException("metadata", $"Keeper image {request.TargetImageId} no longer exists.");

        var sourceIds = request.SourceImageIds;
        state.SetStage("metadata");
        if (sourceIds.Count > 0)
        {
            var previousTargetTagIds = await db.Set<ImageTag>()
                .Where(row => row.ImageId == request.TargetImageId)
                .Select(row => row.TagId)
                .ToArrayAsync(ct);
            await MergeImageMetadataAsync(db, request.TargetImageId, sourceIds, ct);
            if (tagProvenanceService is not null)
            {
                var currentTargetTagIds = await db.Set<ImageTag>()
                    .Where(row => row.ImageId == request.TargetImageId)
                    .Select(row => row.TagId)
                    .ToArrayAsync(ct);
                await tagProvenanceService.SyncTagSetAsync(
                    AffinityHostType.Image,
                    request.TargetImageId,
                    previousTargetTagIds,
                    currentTargetTagIds,
                    cancellationToken: ct);
                foreach (var sourceId in sourceIds)
                    await tagProvenanceService.RemoveForHostAsync(AffinityHostType.Image, sourceId, ct);
            }
            await db.SaveChangesAsync(ct);
        }

        state.SetStage("deletion");
        foreach (var sourceId in sourceIds)
            await InvokeThumbnailServiceAsync(services, "DeleteImageGeneratedFilesAsync", sourceId, ct);

        if (sourceIds.Count > 0)
        {
            db.CustomFieldValues.RemoveRange(await db.CustomFieldValues
                .Where(value => value.EntityType == CustomFieldEntityTypes.Image && sourceIds.Contains(value.EntityId))
                .ToListAsync(ct));
            db.Segments.RemoveRange(await db.Segments
                .Where(segment => segment.HostType == SegmentHostType.Image && sourceIds.Contains(segment.HostId))
                .ToListAsync(ct));
            db.Detections.RemoveRange(await db.Detections
                .Where(detection => detection.HostType == DetectionHostType.Image && sourceIds.Contains(detection.HostId))
                .ToListAsync(ct));
            db.GroupItems.RemoveRange(await db.GroupItems
                .Where(item => (item.ImageId != null && sourceIds.Contains(item.ImageId.Value))
                    || (item.HostType == "image" && sourceIds.Contains(item.HostId)))
                .ToListAsync(ct));
            db.Images.RemoveRange(await db.Images.Where(image => sourceIds.Contains(image.Id)).ToListAsync(ct));
            await db.SaveChangesAsync(ct);
        }

        if (request.FileIds.Count > 0)
            await PruneImageFilesAsync(db, request.TargetImageId, request.FileIds, ct);
    }

    private static async Task MergeImageMetadataAsync(CoveContext db, int targetId, IReadOnlyCollection<int> sourceIds, CancellationToken ct)
    {
        var haveTags = (await db.Set<ImageTag>().Where(row => row.ImageId == targetId).Select(row => row.TagId).ToListAsync(ct)).ToHashSet();
        foreach (var row in await db.Set<ImageTag>().Where(row => sourceIds.Contains(row.ImageId)).ToListAsync(ct))
        {
            if (haveTags.Add(row.TagId))
                db.Set<ImageTag>().Add(new ImageTag { ImageId = targetId, TagId = row.TagId });
            db.Remove(row);
        }
        var havePerformers = (await db.Set<ImagePerformer>().Where(row => row.ImageId == targetId).Select(row => row.PerformerId).ToListAsync(ct)).ToHashSet();
        foreach (var row in await db.Set<ImagePerformer>().Where(row => sourceIds.Contains(row.ImageId)).ToListAsync(ct))
        {
            if (havePerformers.Add(row.PerformerId))
                db.Set<ImagePerformer>().Add(new ImagePerformer { ImageId = targetId, PerformerId = row.PerformerId });
            db.Remove(row);
        }
        var haveGalleries = (await db.Set<ImageGallery>().Where(row => row.ImageId == targetId).Select(row => row.GalleryId).ToListAsync(ct)).ToHashSet();
        foreach (var row in await db.Set<ImageGallery>().Where(row => sourceIds.Contains(row.ImageId)).ToListAsync(ct))
        {
            if (haveGalleries.Add(row.GalleryId))
                db.Set<ImageGallery>().Add(new ImageGallery { ImageId = targetId, GalleryId = row.GalleryId });
            db.Remove(row);
        }
        var haveUrls = (await db.Images.Where(image => image.Id == targetId).SelectMany(image => image.Urls).Select(row => row.Url).ToListAsync(ct)).ToHashSet(StringComparer.OrdinalIgnoreCase);
        foreach (var row in await db.Images.Where(image => sourceIds.Contains(image.Id)).SelectMany(image => image.Urls).ToListAsync(ct))
        {
            if (haveUrls.Add(row.Url))
                row.ImageId = targetId;
            else
                db.Remove(row);
        }
        foreach (var file in await db.ImageFiles.Where(file => file.ImageId != null && sourceIds.Contains(file.ImageId.Value)).ToListAsync(ct))
            file.ImageId = targetId;

        foreach (var sourceId in sourceIds)
        {
            await MergeEngagementAsync(db, AffinityHostType.Image, RatingHostType.Image, InteractionHostType.Image, targetId, sourceId, false, ct);
            await db.SaveChangesAsync(ct);
        }
    }

    private static async Task PruneImageFilesAsync(CoveContext db, int imageId, IReadOnlyCollection<int> fileIds, CancellationToken ct)
    {
        var all = await db.ImageFiles.Where(file => file.ImageId == imageId).ToListAsync(ct);
        var dropIds = fileIds.Distinct().ToHashSet();
        var drop = all.Where(file => dropIds.Contains(file.Id)).ToList();
        if (drop.Count != dropIds.Count || drop.Count == 0 || drop.Count == all.Count)
            throw new DuplicateDeletionStageException("deletion", "Refusing to remove zero, unknown, or every image file.");
        if (drop.Any(file => file.ZipFileId != null || DuplicateManagerExtension.IsArchivePath(file.Path)))
            throw new DuplicateDeletionStageException("deletion", "Archive entries cannot be removed.");

        var cleanup = PermanentFileCleanup.Delete(drop.Select(file => new FileCleanupTarget(file.Id, file.Path!, file.Size)));
        var deletedIds = cleanup.DeletedIds.ToHashSet();
        db.ImageFiles.RemoveRange(drop.Where(file => deletedIds.Contains(file.Id)));
        await db.SaveChangesAsync(ct);
        if (cleanup.Failed.Count > 0)
            throw new DuplicateDeletionStageException("deletion", string.Join("; ", cleanup.Failed.Select(failure => failure.Error)));
    }

    private static async Task InvokeThumbnailServiceAsync(IServiceProvider services, string methodName, object entityId, CancellationToken ct)
    {
        var serviceType = AppDomain.CurrentDomain.GetAssemblies()
            .Select(assembly => assembly.GetType("Cove.Api.Services.IThumbnailService", throwOnError: false))
            .FirstOrDefault(type => type is not null)
            ?? throw new InvalidOperationException("Cove's generated-media cleanup service is unavailable.");
        var service = services.GetService(serviceType)
            ?? throw new InvalidOperationException("Cove's generated-media cleanup service is unavailable.");
        var method = serviceType.GetMethods(BindingFlags.Instance | BindingFlags.Public)
            .SingleOrDefault(candidate => candidate.Name == methodName && candidate.GetParameters().Length == 2)
            ?? throw new InvalidOperationException($"Cove's {methodName} operation is unavailable.");
        try
        {
            if (method.Invoke(service, [entityId, ct]) is Task task)
                await task;
            else
                throw new InvalidOperationException($"Cove's {methodName} operation did not return a task.");
        }
        catch (TargetInvocationException ex) when (ex.InnerException is not null)
        {
            throw ex.InnerException;
        }
    }

    private static string? Pick(string? target, string? source, bool overwrite)
        => overwrite ? First(source, target) : First(target, source);
    private static DateOnly? Pick(DateOnly? target, DateOnly? source, bool overwrite)
        => overwrite ? source ?? target : target ?? source;
    private static int? Pick(int? target, int? source, bool overwrite)
        => overwrite ? source ?? target : target ?? source;
    private static string? First(string? first, string? second)
        => !string.IsNullOrWhiteSpace(first) ? first : !string.IsNullOrWhiteSpace(second) ? second : null;
    private static DateTime? Earlier(DateTime? left, DateTime? right) => left is null ? right : right is null ? left : left < right ? left : right;
    private static DateTime? Later(DateTime? left, DateTime? right) => left is null ? right : right is null ? left : left > right ? left : right;

    private static void AddMissing<T, TKey>(
        ICollection<T> target,
        IEnumerable<T> source,
        Func<T, TKey> key,
        Func<T, T> clone,
        IEqualityComparer<TKey>? comparer = null)
        where TKey : notnull
    {
        var existing = new HashSet<TKey>(target.Select(key), comparer);
        foreach (var row in source)
        {
            if (existing.Add(key(row)))
                target.Add(clone(row));
        }
    }

    private sealed class MutableJobState(string operationId, string mediaType, int total)
    {
        private readonly object _gate = new();
        private readonly List<int> _completedIds = [];
        private readonly List<DuplicateDeletionFailure> _failed = [];
        private readonly List<DuplicateDeletionWarning> _warnings = [];
        private string? _coreJobId;
        private string _status = "pending";
        private string _stage = "queued";
        private int _processed;
        private int? _currentSourceId;
        private int? _currentTargetId;
        private string? _error;

        public string MediaType => mediaType;
        public string Stage { get { lock (_gate) return _stage; } }
        public string Status { get { lock (_gate) return _status; } }
        public int FailedCount { get { lock (_gate) return _failed.Count; } }

        public void AttachCoreJob(string coreJobId) { lock (_gate) _coreJobId = coreJobId; }
        public void Start() { lock (_gate) { _status = "running"; _stage = "preparing"; } }
        public void BeginItem(int sourceId, int targetId, string stage) { lock (_gate) { _currentSourceId = sourceId; _currentTargetId = targetId; _stage = stage; } }
        public void SetStage(string stage) { lock (_gate) _stage = stage; }
        public void CompleteItem(int sourceId, IEnumerable<string> warnings)
        {
            lock (_gate)
            {
                _completedIds.Add(sourceId);
                _warnings.AddRange(warnings.Select(message => new DuplicateDeletionWarning(sourceId, message)));
                _processed++;
            }
        }
        public void FailItem(int sourceId, string stage, string message)
        {
            lock (_gate)
            {
                _failed.Add(new DuplicateDeletionFailure(sourceId, stage, message));
                _processed++;
            }
        }
        public void Finish() { lock (_gate) { _status = _failed.Count == 0 ? "complete" : "partial"; _stage = "finished"; _currentSourceId = null; _currentTargetId = null; } }
        public void Cancel() { lock (_gate) { _status = "cancelled"; _stage = "cancelled"; } }
        public void Fatal(string message) { lock (_gate) { _status = "failed"; _stage = "failed"; _error = message; } }

        public DuplicateDeletionJobSnapshot Snapshot()
        {
            lock (_gate)
            {
                return new DuplicateDeletionJobSnapshot(
                    operationId,
                    _coreJobId,
                    mediaType,
                    _status,
                    _stage,
                    total,
                    _processed,
                    _currentSourceId,
                    _currentTargetId,
                    _completedIds.ToArray(),
                    _failed.ToArray(),
                    _warnings.ToArray(),
                    _error);
            }
        }
    }

    private sealed class DuplicateDeletionStageException(string stage, string message) : Exception(message)
    {
        public string Stage { get; } = stage;
    }
}
