import { runWindowsPowerShell } from '../desktop/windows-powershell.cjs';

export function verifyWindowsRelease(files, thumbprint) {
  if (process.platform !== 'win32' || !/^[0-9a-f]{40}$/i.test(thumbprint ?? '')) {
    throw new Error('A Windows signer thumbprint is required');
  }
  return runWindowsPowerShell(`
    $ErrorActionPreference = 'Stop'
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
    $request = Microsoft.PowerShell.Utility\\ConvertFrom-Json -InputObject $json
    foreach ($file in $request.files) {
      $signature = Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $file
      if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or
          $signature.SignerCertificate.Thumbprint -ne $request.thumbprint -or -not $signature.TimeStamperCertificate) {
        throw "Valid timestamped Authenticode signature by the expected publisher required: $([IO.Path]::GetFileName($file))"
      }
    }
  `, { files, thumbprint });
}
