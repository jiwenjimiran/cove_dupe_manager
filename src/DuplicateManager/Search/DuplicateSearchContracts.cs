namespace Cove.DuplicateManager.Search;

public sealed record DuplicateSearchStartRequest(
    string MatchType = "fingerprint",
    int Distance = 4,
    double? DurationDiff = 5,
    IReadOnlyList<string>? IncludePaths = null,
    IReadOnlyList<string>? ExcludePaths = null,
    double MinimumDuration = 0,
    IReadOnlyList<DuplicateKeeperRule>? KeeperRules = null);

public sealed record DuplicateSearchStarted(Guid SearchId, string JobId, int CandidateCount);

