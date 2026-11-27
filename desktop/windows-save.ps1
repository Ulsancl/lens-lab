$ErrorActionPreference = 'Stop'
$temporary = $null
try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
    $request = Microsoft.PowerShell.Utility\ConvertFrom-Json -InputObject $json
    $target = [string]$request.target
    $parent = [IO.Path]::GetDirectoryName($target)
    $pending = [IO.Path]::Combine($parent, '.lens-' + [Guid]::NewGuid().ToString('N') + '.tmp')

    # Set the private DACL during creation, before any project bytes exist.
    $security = [Security.AccessControl.FileSecurity]::new()
    $security.SetAccessRuleProtection($true, $false)
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($user, 'FullControl', 'Allow')
    $security.SetAccessRule($rule)
    $stream = [IO.FileStream]::new($pending, 'CreateNew',
        [Security.AccessControl.FileSystemRights]::Write, 'None', 4096, 'None', $security)
    $temporary = $pending
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes([string]$request.contents)
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }

    $delays = @(25, 50, 100, 200, 400)
    for ($attempt = 0; ; $attempt++) {
        # Reject reparse points before the initial publication and on every retry.
        $directory = [IO.DirectoryInfo]::new($parent)
        while ($null -ne $directory) {
            $attributes = [IO.File]::GetAttributes($directory.FullName)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked project directory' }
            $directory = $directory.Parent
        }
        $exists = $true
        try { $attributes = [IO.File]::GetAttributes($target) }
        catch {
            if (($_.Exception.GetBaseException().HResult -band 0xffff) -ne 2) { throw }
            $exists = $false
        }
        if ($exists -and ($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint))) {
            throw 'Project target must be a regular file'
        }
        try {
            if ($exists) {
                # Windows ReplaceFile merges the replaced file's DACL. Fail on metadata errors.
                [IO.File]::Replace($temporary, $target, [NullString]::Value, $false)
            } else {
                # Move without overwrite if another writer created the target.
                [IO.File]::Move($temporary, $target)
            }
            $temporary = $null
            break
        } catch {
            $code = $_.Exception.GetBaseException().HResult -band 0xffff
            if ($attempt -ge $delays.Count -or $code -notin @(5, 32, 33)) { throw }
            [Threading.Thread]::Sleep($delays[$attempt])
        }
    }
} catch {
    [Console]::Error.WriteLine($_.Exception.GetBaseException().Message)
    exit 1
} finally {
    if ($null -ne $temporary) {
        try { [IO.File]::Delete($temporary) } catch { }
    }
}
