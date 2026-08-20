using Cove.DuplicateManager;

var root = Path.Combine(Path.GetTempPath(), $"duplicate-manager-tests-{Guid.NewGuid():N}");
Directory.CreateDirectory(root);
try
{
    var keeper = Path.Combine(root, "keeper.jpg");
    var duplicate = Path.Combine(root, "duplicate.jpg");
    File.WriteAllText(keeper, "keeper");
    File.WriteAllText(duplicate, "duplicate");

    var result = PermanentFileCleanup.Delete([new FileCleanupTarget(2, duplicate, new FileInfo(duplicate).Length)]);
    Assert(result.DeletedIds.SequenceEqual([2]), "selected duplicate was not reported deleted");
    Assert(result.Failed.Count == 0, "successful deletion reported a failure");
    Assert(File.Exists(keeper), "keeper file was deleted");
    Assert(!File.Exists(duplicate), "selected duplicate remained on disk");
    Assert(!Directory.Exists(Path.Combine(root, ".dedup-trash")), "cleanup created .dedup-trash");

    var undeletable = Path.Combine(root, "directory-target");
    Directory.CreateDirectory(undeletable);
    result = PermanentFileCleanup.Delete([new FileCleanupTarget(3, undeletable, 1)]);
    Assert(result.DeletedIds.Count == 0, "failed deletion was reported successful");
    Assert(result.Failed.Count == 1 && result.Failed[0].Id == 3, "failed deletion was not reported");
    Assert(Directory.Exists(undeletable), "failed target was unexpectedly removed");

    Console.WriteLine("Permanent file cleanup regression tests passed.");
}
finally
{
    Directory.Delete(root, true);
}

static void Assert(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}
