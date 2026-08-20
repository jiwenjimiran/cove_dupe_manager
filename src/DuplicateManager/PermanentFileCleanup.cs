namespace Cove.DuplicateManager;

public sealed record FileCleanupTarget(int Id, string Path, long Size);
public sealed record FileCleanupFailure(int Id, string Path, string Error);
public sealed record FileCleanupResult(IReadOnlyList<int> DeletedIds, long Freed, IReadOnlyList<FileCleanupFailure> Failed);

public static class PermanentFileCleanup
{
    public static FileCleanupResult Delete(IEnumerable<FileCleanupTarget> targets)
    {
        var deleted = new List<int>();
        var failed = new List<FileCleanupFailure>();
        long freed = 0;
        foreach (var target in targets)
        {
            try
            {
                if (Directory.Exists(target.Path)) throw new IOException("The cleanup target is a directory, not a file.");
                if (!string.IsNullOrWhiteSpace(target.Path) && File.Exists(target.Path)) File.Delete(target.Path);
                deleted.Add(target.Id);
                freed += target.Size;
            }
            catch (Exception ex)
            {
                failed.Add(new FileCleanupFailure(target.Id, target.Path, ex.Message));
            }
        }
        return new FileCleanupResult(deleted, freed, failed);
    }
}
