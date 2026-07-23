param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('get', 'set', 'delete')]
    [string]$Operation,

    [Parameter(Mandatory = $true)]
    [string]$Service,

    [Parameter(Mandatory = $true)]
    [string]$Account
)

$ErrorActionPreference = 'Stop'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $Utf8
[Console]::OutputEncoding = $Utf8

[Windows.Security.Credentials.PasswordVault, Windows.Security.Credentials, ContentType = WindowsRuntime] | Out-Null
[Windows.Security.Credentials.PasswordCredential, Windows.Security.Credentials, ContentType = WindowsRuntime] | Out-Null

$Vault = New-Object Windows.Security.Credentials.PasswordVault
$ChunkPrefix = '__clodex_chunked__:'
$ChunkSize = 1000
$MaxChunks = 128
$NotFoundHResult = -2147023728

function Test-NotFoundException {
    param([System.Exception]$Exception)

    $Current = $Exception
    while ($null -ne $Current) {
        if ($Current.HResult -eq $NotFoundHResult) {
            return $true
        }
        $Current = $Current.InnerException
    }
    return $false
}

function Get-Credential {
    param([string]$Username)

    try {
        $Credential = $Vault.Retrieve($Service, $Username)
        $Credential.RetrievePassword()
        return $Credential
    }
    catch {
        if (Test-NotFoundException $_.Exception) {
            return $null
        }
        throw
    }
}

function Set-Credential {
    param(
        [string]$Username,
        [string]$Password
    )

    $Credential = New-Object Windows.Security.Credentials.PasswordCredential($Service, $Username, $Password)
    $Vault.Add($Credential)
}

function Remove-Credential {
    param([string]$Username)

    $Credential = Get-Credential $Username
    if ($null -eq $Credential) {
        return $false
    }
    $Vault.Remove($Credential)
    return $true
}

function Get-ChunkDescriptor {
    param([string]$Value)

    if ($Value -match '^__clodex_chunked__:v2:([0-9a-f]{32}):([1-9][0-9]{0,2}):([0-9a-f]{64})$') {
        $Count = [int]$Matches[2]
        if ($Count -gt $MaxChunks) {
            throw 'Credential chunk count exceeds the supported limit'
        }
        return @{
            Generation = $Matches[1]
            Count = $Count
            Digest = $Matches[3]
        }
    }
    if ($Value -match '^__clodex_chunked__:([0-9a-f]{32}):([1-9][0-9]{0,2})$') {
        $Count = [int]$Matches[2]
        if ($Count -gt $MaxChunks) {
            throw 'Credential chunk count exceeds the supported limit'
        }
        return @{
            Generation = $Matches[1]
            Count = $Count
            Digest = ''
        }
    }
    return $null
}

function Get-Sha256 {
    param([string]$Value)

    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $Hash = $Hasher.ComputeHash($Utf8.GetBytes($Value))
        return ([BitConverter]::ToString($Hash)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $Hasher.Dispose()
    }
}

function Get-ChunkUsername {
    param(
        [string]$Generation,
        [int]$Index
    )

    return "${Account}::chunk::${Generation}::${Index}"
}

function Get-ResourceCredentials {
    try {
        return @($Vault.FindAllByResource($Service))
    }
    catch {
        if (Test-NotFoundException $_.Exception) {
            return @()
        }
        throw
    }
}

function Remove-AccountChunks {
    param([string]$KeepGeneration = '')

    $Prefix = "${Account}::chunk::"
    $KeepPrefix = if ($KeepGeneration) { "${Prefix}${KeepGeneration}::" } else { '' }
    $Removed = 0
    foreach ($Credential in (Get-ResourceCredentials)) {
        if (-not $Credential.UserName.StartsWith($Prefix, [StringComparison]::Ordinal)) {
            continue
        }
        if ($KeepPrefix -and $Credential.UserName.StartsWith($KeepPrefix, [StringComparison]::Ordinal)) {
            continue
        }
        $Vault.Remove($Credential)
        $Removed += 1
    }
    return $Removed
}

function Read-StoredValue {
    $Base = Get-Credential $Account
    if ($null -eq $Base) {
        return $null
    }

    $Descriptor = Get-ChunkDescriptor $Base.Password
    if ($null -eq $Descriptor) {
        if ($Base.Password.StartsWith($ChunkPrefix, [StringComparison]::Ordinal)) {
            throw 'Credential chunk descriptor is invalid'
        }
        return $Base.Password
    }

    $Builder = New-Object System.Text.StringBuilder
    for ($Index = 0; $Index -lt $Descriptor.Count; $Index += 1) {
        $Chunk = Get-Credential (Get-ChunkUsername $Descriptor.Generation $Index)
        if ($null -eq $Chunk) {
            throw 'Credential chunk is missing'
        }
        $Builder.Append($Chunk.Password) | Out-Null
    }
    $Value = $Builder.ToString()
    if ($Descriptor.Digest -and (Get-Sha256 $Value) -ne $Descriptor.Digest) {
        throw 'Credential chunk digest does not match'
    }
    return $Value
}

function Write-StandardOutputExact {
    param([string]$Value)

    $Bytes = $Utf8.GetBytes($Value)
    $Output = [Console]::OpenStandardOutput()
    $Output.Write($Bytes, 0, $Bytes.Length)
    $Output.Flush()
}

try {
    if ($Operation -eq 'get') {
        $Value = Read-StoredValue
        if ($null -eq $Value) {
            exit 2
        }
        Write-StandardOutputExact $Value
        exit 0
    }

    if ($Operation -eq 'delete') {
        $Base = Get-Credential $Account
        if ($null -ne $Base) {
            $Vault.Remove($Base)
        }
        $RemovedChunks = Remove-AccountChunks
        if ($null -eq $Base -and $RemovedChunks -eq 0) {
            exit 2
        }
        exit 0
    }

    $Value = [Console]::In.ReadToEnd()

    if ($Value.Length -le $ChunkSize) {
        Set-Credential $Account $Value
        Remove-AccountChunks | Out-Null
        exit 0
    }

    $Generation = [Guid]::NewGuid().ToString('N')
    [int]$ChunkCount = [Math]::Max(1, [Math]::Ceiling($Value.Length / $ChunkSize))
    if ($ChunkCount -gt $MaxChunks) {
        throw 'Credential exceeds the supported chunk count'
    }
    $Digest = Get-Sha256 $Value
    $WrittenChunks = 0
    $Committed = $false

    try {
        for ($Index = 0; $Index -lt $ChunkCount; $Index += 1) {
            $Start = $Index * $ChunkSize
            $Length = [Math]::Min($ChunkSize, $Value.Length - $Start)
            $Chunk = if ($Length -gt 0) { $Value.Substring($Start, $Length) } else { '' }
            Set-Credential (Get-ChunkUsername $Generation $Index) $Chunk
            $WrittenChunks += 1
        }
        Set-Credential $Account "${ChunkPrefix}v2:${Generation}:${ChunkCount}:${Digest}"
        $Committed = $true
    }
    finally {
        if (-not $Committed) {
            for ($Index = 0; $Index -lt $WrittenChunks; $Index += 1) {
                Remove-Credential (Get-ChunkUsername $Generation $Index) | Out-Null
            }
        }
    }

    Remove-AccountChunks $Generation | Out-Null
    exit 0
}
catch {
    [Console]::Error.WriteLine('Credential helper operation failed')
    exit 1
}
