using System.Text.Json;
using System.Text.Json.Serialization;
using Cove.Plugins;
using Cove.Sdk;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

namespace Cove.DuplicateManager;

public sealed partial class DuplicateManagerExtension : IExtension, IUIExtension, IStatefulExtension, IApiExtension
{
    public const string ExtensionId = "io.github.jiwenjimiran.duplicate-manager";
    private const string SettingsKey = "settings";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        WriteIndented = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    private IExtensionStore? _store;

    public string Id => ExtensionId;
    public string Name => "Duplicate Manager";
    public string Version => "2.0.2";
    public string? Description => "Safe, explainable duplicate review and cleanup for Cove videos and images.";
    public string? Author => "jiwenji";
    public string? Url => "https://github.com/jiwenjimiran/cove_dupe_manager";
    public string? IconUrl => null;
    public IReadOnlyList<string> Categories => ["tools", "library", "content-management", "search", "ui"];
    public string? MinCoveVersion => "1.1.0";
    public IReadOnlyDictionary<string, string> Dependencies => new Dictionary<string, string>();

    public void ConfigureServices(IServiceCollection services, ExtensionContext context) { }
    public void SetStore(IExtensionStore store) => _store = store;

    public UIManifest GetUIManifest() => new()
    {
        PageOverrides =
        [
            new UIPageOverride(
                TargetPage: "duplicates",
                ExtensionId: ExtensionId,
                ComponentName: "DuplicateManagerPage",
                Priority: 500)
        ],
        Pages =
        [
            new UIPageDefinition(
                Route: "extensions/duplicate-images",
                Label: "Duplicate Images",
                Icon: "Images",
                ShowInNav: true,
                NavOrder: 91,
                RequiredPermission: "images.read",
                ComponentName: "DuplicateImagesPage",
                ExtensionId: ExtensionId)
        ],
        SettingsPanels =
        [
            new UISettingsPanel(
                Id: $"{ExtensionId}:installed",
                Label: "Duplicate Manager",
                ExtensionId: ExtensionId,
                ComponentName: "DuplicateManagerSettingsPanel",
                Order: 250,
                TargetTab: "extensions")
        ]
    };

    public void MapEndpoints(IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/ext/duplicate-manager/settings", async (HttpContext ctx) =>
        {
            return Results.Json(await LoadSettingsAsync(ctx.RequestAborted), JsonOptions);
        }).RequireCovePermission("videos.read");

        endpoints.MapPut("/api/ext/duplicate-manager/settings", async (HttpContext ctx) =>
        {
            var incoming = await JsonSerializer.DeserializeAsync<DuplicateManagerSettings>(ctx.Request.Body, JsonOptions, ctx.RequestAborted);
            var settings = DuplicateManagerSettings.Normalize(incoming);
            if (_store is null)
                return Results.Problem("Extension storage is not initialized.");
            await _store.SetAsync(SettingsKey, JsonSerializer.Serialize(settings, JsonOptions), ctx.RequestAborted);
            return Results.Json(settings, JsonOptions);
        }).RequireCovePermission("videos.write");

        MapMergeEndpoints(endpoints);
    }

    private async Task<DuplicateManagerSettings> LoadSettingsAsync(CancellationToken ct)
    {
        if (_store is null)
            return DuplicateManagerSettings.Normalize(null);

        var json = await _store.GetAsync(SettingsKey, ct);
        if (string.IsNullOrWhiteSpace(json))
            return DuplicateManagerSettings.Normalize(null);

        try
        {
            return DuplicateManagerSettings.Normalize(JsonSerializer.Deserialize<DuplicateManagerSettings>(json, JsonOptions));
        }
        catch
        {
            return DuplicateManagerSettings.Normalize(null);
        }
    }
}

public sealed class DuplicateManagerSettings
{
    private static readonly string[] ValidRules = ["metadata", "resolution", "duration", "codec", "bitrate", "size", "oldest", "newest"];
    private static readonly string[] LegacyKeeperRules = ["metadata", "resolution", "codec", "bitrate", "size", "oldest"];
    private static readonly string[] PreviousDefaultKeeperRules = ["resolution", "duration", "codec", "bitrate", "metadata", "oldest"];
    private static readonly string[] PreviousDefaultKeeperRules2 = ["resolution", "codec", "duration", "bitrate", "metadata", "oldest"];
    private static readonly string[] DefaultKeeperRules = ["resolution", "codec", "bitrate", "duration", "metadata", "oldest"];

    public string MatchType { get; set; } = "fingerprint";
    public string FingerprintAlgorithm { get; set; } = "any";
    public int PhashDistance { get; set; } = 8;
    public double MaxDurationDelta { get; set; } = 10;
    public double MinimumDuration { get; set; } = 0;
    public int PageSize { get; set; } = 25;
    public List<string> PreferredCodecs { get; set; } = ["av1", "hevc", "h264", "vp9", "mpeg4"];
    public List<string> KeeperRules { get; set; } = [.. DefaultKeeperRules];
    public string FolderMode { get; set; } = "all";
    public List<string> IncludedPaths { get; set; } = [];
    public bool CopyMissingMetadata { get; set; } = true;
    public bool OverwriteConflictingMetadata { get; set; } = false;
    public string RankingMode { get; set; } = "balanced";
    public int SettingsVersion { get; set; }

    public static DuplicateManagerSettings Normalize(DuplicateManagerSettings? value)
    {
        var isNewInstall = value is null;
        var settings = value ?? new DuplicateManagerSettings();
        settings.MatchType = settings.MatchType?.Trim().ToLowerInvariant() is "phash" or "title" or "remoteid"
            ? settings.MatchType.Trim().ToLowerInvariant()
            : "fingerprint";
        settings.FingerprintAlgorithm = settings.FingerprintAlgorithm?.Trim().ToLowerInvariant() is "md5" or "oshash"
            ? settings.FingerprintAlgorithm.Trim().ToLowerInvariant()
            : "any";
        settings.PhashDistance = Math.Clamp(settings.PhashDistance, 0, 64);
        settings.MaxDurationDelta = Math.Clamp(settings.MaxDurationDelta, 0, 86_400);
        settings.MinimumDuration = Math.Clamp(settings.MinimumDuration, 0, 86_400_000);
        settings.PageSize = Math.Clamp(settings.PageSize, 1, 10_000);
        settings.PreferredCodecs = NormalizeList(settings.PreferredCodecs, ["av1", "hevc", "h264", "vp9", "mpeg4"], lowerCase: true);
        settings.KeeperRules = NormalizeList(settings.KeeperRules, DefaultKeeperRules, lowerCase: true)
            .Where(rule => ValidRules.Contains(rule, StringComparer.OrdinalIgnoreCase))
            .ToList();
        if (settings.KeeperRules.Count == 0
            || settings.KeeperRules.SequenceEqual(LegacyKeeperRules, StringComparer.OrdinalIgnoreCase)
            || settings.KeeperRules.SequenceEqual(PreviousDefaultKeeperRules, StringComparer.OrdinalIgnoreCase)
            || settings.KeeperRules.SequenceEqual(PreviousDefaultKeeperRules2, StringComparer.OrdinalIgnoreCase))
            settings.KeeperRules = [.. DefaultKeeperRules];
        settings.IncludedPaths = NormalizeList(settings.IncludedPaths, [], lowerCase: false);
        settings.FolderMode = settings.FolderMode?.Trim().ToLowerInvariant() is "include" or "exclude"
            ? settings.FolderMode.Trim().ToLowerInvariant()
            : settings.IncludedPaths.Count > 0 ? "include" : "all";
        if (!settings.CopyMissingMetadata)
            settings.OverwriteConflictingMetadata = false;
        settings.RankingMode = !isNewInstall && settings.SettingsVersion < 2
            ? "custom"
            : settings.RankingMode?.Trim().ToLowerInvariant() == "custom" ? "custom" : "balanced";
        settings.SettingsVersion = 2;
        return settings;
    }

    private static List<string> NormalizeList(IEnumerable<string>? values, IEnumerable<string> fallback, bool lowerCase)
    {
        var normalized = (values ?? fallback)
            .Select(value => lowerCase ? value?.Trim().ToLowerInvariant() ?? string.Empty : value?.Trim() ?? string.Empty)
            .Where(value => value.Length > 0)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();
        return normalized.Count > 0 ? normalized : fallback.ToList();
    }
}
