[CmdletBinding()]
param([ValidateSet('Release','Debug')][string]$BuildType='Release')
$ErrorActionPreference='Stop'
Set-Location $PSScriptRoot

# Optional machine-local tool paths are ignored by Git. Standard Android Studio
# installations may use JAVA_HOME / ANDROID_HOME and the Gradle wrapper instead.
$configFile=Join-Path $PSScriptRoot '.local-build.json'
$localConfig=if(Test-Path -LiteralPath $configFile){Get-Content -LiteralPath $configFile -Raw|ConvertFrom-Json}else{$null}
if($localConfig.javaHome){$env:JAVA_HOME=$localConfig.javaHome}
if($localConfig.androidHome){$env:ANDROID_HOME=$localConfig.androidHome}
if($localConfig.gradleUserHome){$env:GRADLE_USER_HOME=$localConfig.gradleUserHome}
if($localConfig.source){$env:HW_ATTENDANCE_SOURCE=$localConfig.source}
if(!$env:JAVA_HOME -or !(Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin/java.exe'))){throw 'Install Java 21 and set JAVA_HOME.'}
if(!$env:ANDROID_HOME -or !(Test-Path -LiteralPath $env:ANDROID_HOME)){throw 'Install Android SDK 36 and set ANDROID_HOME.'}
if(!(Test-Path -LiteralPath 'node_modules')){
  & npm.cmd ci --offline=false
  if($LASTEXITCODE -ne 0){throw 'npm ci failed.'}
}
& npm.cmd run sync
if($LASTEXITCODE -ne 0){throw 'Web asset build failed.'}
& npm.cmd test
if($LASTEXITCODE -ne 0){throw 'App checks failed.'}

try {
  if($BuildType -eq 'Release'){
    $signDir=Join-Path $PSScriptRoot '.signing'
    $key=Join-Path $signDir 'hw-attendance-admin.p12'
    $secret=Join-Path $signDir 'password.clixml'
    if((Test-Path -LiteralPath $key) -and !(Test-Path -LiteralPath $secret)){throw 'Signing password file is missing. Restore it; do not replace the existing key.'}
    if(!(Test-Path -LiteralPath $key)){
      if(Test-Path -LiteralPath $secret){throw 'Signing key is missing. Restore it; do not generate a different release identity.'}
      New-Item -ItemType Directory -Path $signDir -Force|Out-Null
      $random=New-Object byte[] 48
      $generator=[Security.Cryptography.RandomNumberGenerator]::Create()
      $generator.GetBytes($random);$generator.Dispose()
      $password=[Convert]::ToBase64String($random)
      ConvertTo-SecureString $password -AsPlainText -Force|Export-Clixml -LiteralPath $secret
      $env:HW_RELEASE_STORE_PASSWORD=$password
      & (Join-Path $env:JAVA_HOME 'bin/keytool.exe') -genkeypair -keystore $key -storetype PKCS12 -alias hw-attendance-admin -keyalg RSA -keysize 3072 -validity 10000 -dname 'CN=Homeweavers Attendance Admin, O=Homeweavers' -storepass:env HW_RELEASE_STORE_PASSWORD -keypass:env HW_RELEASE_STORE_PASSWORD
      if($LASTEXITCODE -ne 0){throw 'Signing key generation failed. Review .signing before retrying.'}
      $password=$null
    }
    $secure=Import-Clixml -LiteralPath $secret
    $env:HW_RELEASE_STORE_PASSWORD=[Net.NetworkCredential]::new('',$secure).Password
    $env:HW_RELEASE_KEY_PASSWORD=$env:HW_RELEASE_STORE_PASSWORD
    $env:HW_RELEASE_STORE=$key
  }
  $gradle=if($localConfig.gradle){$localConfig.gradle}else{Join-Path $PSScriptRoot 'android/gradlew.bat'}
  $buildArgs=@('--no-daemon','-p',(Join-Path $PSScriptRoot 'android'),(':app:assemble'+$BuildType),'--console=plain')
  # Respect the host's configured network proxy without logging its URL.
  if($env:HTTPS_PROXY){
    $buildProxy=[uri]$env:HTTPS_PROXY
    $buildArgs+=('-Dhttps.proxyHost='+$buildProxy.Host)
    $buildArgs+=('-Dhttps.proxyPort='+$buildProxy.Port)
    $buildArgs+=('-Dhttp.proxyHost='+$buildProxy.Host)
    $buildArgs+=('-Dhttp.proxyPort='+$buildProxy.Port)
  }
  & $gradle @buildArgs
  if($LASTEXITCODE -ne 0){throw 'Android compilation failed.'}
  $kind=$BuildType.ToLowerInvariant()
  $apk=Join-Path $PSScriptRoot "android/app/build/outputs/apk/$kind/app-$kind.apk"
  if(!(Test-Path -LiteralPath $apk)){throw 'Expected signed APK was not produced.'}
  & (Join-Path $env:ANDROID_HOME 'build-tools/36.0.0/apksigner.bat') verify --verbose $apk
  if($LASTEXITCODE -ne 0){throw 'APK signature verification failed.'}
  $out=Join-Path $PSScriptRoot 'artifacts'
  New-Item -ItemType Directory -Path $out -Force|Out-Null
  $dest=Join-Path $out "HW-Attendance-Admin-$kind.apk"
  Copy-Item -LiteralPath $apk -Destination $dest -Force
  $digest=(Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLowerInvariant()
  [IO.File]::WriteAllText($dest+'.sha256',$digest+'  '+[IO.Path]::GetFileName($dest)+[Environment]::NewLine)
  Write-Host "Built and verified: $dest"
} finally {
  Remove-Item Env:HW_RELEASE_STORE_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:HW_RELEASE_KEY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:HW_RELEASE_STORE -ErrorAction SilentlyContinue
}
