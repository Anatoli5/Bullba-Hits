; Native installer. All game writes are explicit [Files] entries managed by Inno.
#include "generated\build.iss"

[Setup]
AppId=LocalArmorInspectorHits
AppName=Bullba Hits
AppVersion={#ProductVersion}
AppPublisher=Bullba Hits
DefaultDirName=C:\Games\World_of_Tanks_NA
AppendDefaultDirName=no
DisableDirPage=no
DisableProgramGroupPage=yes
DirExistsWarning=no
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=commandline
SetupArchitecture=x64
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
WizardStyle=modern
SetupIconFile=armor-inspector.ico
OutputDir=..\dist
Compression=lzma2
SolidCompression=yes
CloseApplications=no
RestartApplications=no
UninstallFilesDir={app}\mods\configs\local.armor_inspector\installer
UninstallDisplayIcon={app}\mods\configs\local.armor_inspector\web\icon.ico
UninstallDisplayName=Bullba Hits
SetupMutex=LocalArmorInspectorSetup
#ifdef SignBuild
; Sign both the outer EXE and the temporary setup/uninstaller executables.
SignTool=BullbaHitsSign
SignedUninstaller=yes
SignToolRunMinimized=yes
#endif
#ifdef TestBuild
CreateUninstallRegKey=no
UsePreviousAppDir=no
UsePreviousTasks=no
OutputBaseFilename=BullbaHits-{#ProductVersion}-Setup-Test
#else
UsePreviousAppDir=yes
OutputBaseFilename=BullbaHits-{#ProductVersion}-Setup
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
WelcomeLabel1=Bullba Hits Setup
WelcomeLabel2=The mod records hits; the saved history opens in an ordinary browser.%n%nSupports World of Tanks PC NA 2.4.0.1 #950.%nClose the game before installing.
SelectDirLabel3=Select the World of Tanks folder that contains version.xml and the res directory.
SelectDirBrowseLabel=Game folder:
FinishedLabelNoIcons=Installation complete. The mod starts recording hits once the game runs.%n%nThe viewer is Viewer.html in mods\configs\local.armor_inspector. After a battle press “Refresh” in the viewer.
FinishedLabel=Installation complete. The mod starts recording hits once the game runs.%n%nOpen the Bullba Hits shortcut to view them. After a battle press “Refresh” in the viewer.

[Tasks]
Name: desktopicon; Description: "Create a desktop shortcut for the viewer"; GroupDescription: "Shortcut:"

[Files]
#include "generated\files.iss"

[Icons]
Name: "{code:GetDesktopDir}\Bullba Hits"; Filename: "{code:GetViewerLauncher}"; Parameters: "{code:GetViewerArguments}"; WorkingDir: "{app}\mods\configs\local.armor_inspector"; IconFilename: "{app}\mods\configs\local.armor_inspector\web\icon.ico"; Comment: "Bullba Hits — local hits"; Tasks: desktopicon

[Run]
Filename: "{code:GetViewerLauncher}"; Parameters: "{code:GetViewerArguments}"; Description: "Open Bullba Hits"; Flags: shellexec postinstall skipifsilent unchecked

[Code]
type
  TProcessIDs = array[0..4095] of LongWord;

function EnumProcesses(var IDs: TProcessIDs; Size: LongWord; var Needed: LongWord): Boolean;
  external 'EnumProcesses@psapi.dll stdcall';
function OpenProcess(Access: LongWord; Inherit: Boolean; ID: LongWord): THandle;
  external 'OpenProcess@kernel32.dll stdcall';
function QueryFullProcessImageName(Process: THandle; Flags: LongWord; Buffer: String; var Size: LongWord): Boolean;
  external 'QueryFullProcessImageNameW@kernel32.dll stdcall';
function CloseHandle(Handle: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';

function GetDesktopDir(Param: String): String;
begin
#ifdef TestBuild
  Result := ExpandConstant('{param:TESTDESKTOP|{#TestRoot}\Desktop}');
  if Pos(Lowercase('{#TestRoot}\'), Lowercase(AddBackslash(ExpandFileName(Result)))) <> 1 then
    RaiseException('Test desktop must stay inside the fixture root.');
#else
  Result := ExpandConstant('{userdesktop}');
#endif
end;

function BrowserExecutable: String;
var Candidate: String;
begin
  Result := '';
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe', '', Candidate) then
    if FileExists(Candidate) then begin Result := Candidate; Exit; end;
  if RegQueryStringValue(HKLM64, 'Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe', '', Candidate) then
    if FileExists(Candidate) then begin Result := Candidate; Exit; end;
  if RegQueryStringValue(HKLM32, 'Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe', '', Candidate) then
    if FileExists(Candidate) then begin Result := Candidate; Exit; end;
  Candidate := ExpandConstant('{pf32}\Microsoft\Edge\Application\msedge.exe');
  if FileExists(Candidate) then begin Result := Candidate; Exit; end;
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', '', Candidate) then
    if FileExists(Candidate) then begin Result := Candidate; Exit; end;
  if RegQueryStringValue(HKLM64, 'Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', '', Candidate) then
    if FileExists(Candidate) then begin Result := Candidate; Exit; end;
  Candidate := ExpandConstant('{pf64}\Google\Chrome\Application\chrome.exe');
  if FileExists(Candidate) then begin Result := Candidate; Exit; end;
  Candidate := ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe');
  if FileExists(Candidate) then Result := Candidate;
end;

function AppArguments(const Folder: String): String;
var URL: String;
begin
  URL := AddBackslash(Folder) + 'mods\configs\local.armor_inspector\Viewer.html';
  StringChangeEx(URL, '\', '/', True);
  StringChangeEx(URL, '%', '%25', True);
  StringChangeEx(URL, ' ', '%20', True);
  StringChangeEx(URL, '#', '%23', True);
  StringChangeEx(URL, '?', '%3F', True);
  Result := '--app="file:///' + URL + '" --no-first-run --no-default-browser-check';
end;

function GetViewerLauncher(Param: String): String;
begin
  Result := BrowserExecutable;
  if Result = '' then Result := ExpandConstant('{app}\mods\configs\local.armor_inspector\Viewer.html');
end;

function GetViewerArguments(Param: String): String;
begin
  Result := '';
  if BrowserExecutable <> '' then Result := AppArguments(ExpandConstant('{app}'));
end;

function IsOurShortcut(Link: Variant; const Folder: String): Boolean;
var Name, Viewer: String;
begin
  Viewer := AddBackslash(Folder) + 'mods\configs\local.armor_inspector\Viewer.html';
  Name := Lowercase(ExtractFileName(Link.Path));
  Result := (CompareText(ExpandFileName(Link.Path), ExpandFileName(Viewer)) = 0) or
    (((Name = 'msedge.exe') or (Name = 'chrome.exe')) and (Link.Arguments = AppArguments(Folder)));
end;

procedure MigrateDesktopShortcut;
var Shell, Link: Variant; Path, Backup: String;
begin
  if not WizardIsTaskSelected('desktopicon') then Exit;
  Path := GetDesktopDir('') + '\Armor Inspector — попадания.lnk';
  if not FileExists(Path) then Exit;
  try
    Shell := CreateOleObject('Shell.Application');
    Link := Shell.NameSpace(GetDesktopDir('')).ParseName('Armor Inspector — попадания.lnk').GetLink;
    if not IsOurShortcut(Link, ExpandConstant('{app}')) then Exit;
    Backup := ExpandConstant('{app}\mods\configs\local.armor_inspector\installer\backups\desktop');
    if not ForceDirectories(Backup) then Exit;
    Backup := AddBackslash(Backup) + 'ArmorInspector-' + GetDateTimeString('yyyymmdd-hhnnss', '-', ':') + '.lnk';
    if FileExists(Backup) then Exit;
    if FileCopy(Path, Backup, True) then DeleteFile(Path);
  except
    Log('Legacy shortcut retained: ' + GetExceptionMessage);
  end;
end;

function GameRunning: Boolean;
var
  IDs: TProcessIDs;
  Needed, Count, I, Size: LongWord;
  Handle: THandle;
  Buffer, ExpectedName: String;
begin
  Result := False;
#ifdef TestBuild
  ExpectedName := ExpandConstant('{param:TESTPROCESSNAME|WorldOfTanks.exe}');
#else
  ExpectedName := 'WorldOfTanks.exe';
#endif
  if not EnumProcesses(IDs, SizeOf(IDs), Needed) then
    RaiseException('Could not check whether the game is closed.');
  if Needed >= SizeOf(IDs) then
    RaiseException('Could not read the full process list.');
  Count := Needed div 4;
  if Count = 0 then Exit;
  for I := 0 to Count - 1 do begin
    Handle := OpenProcess($1000, False, IDs[I]);
    if Handle <> 0 then begin
      try
        Size := 32768;
        Buffer := StringOfChar(#0, Size);
        if QueryFullProcessImageName(Handle, 0, Buffer, Size) then begin
          SetLength(Buffer, Size);
          if CompareText(ExtractFileName(Buffer), ExpectedName) = 0 then begin
            Result := True;
            Exit;
          end;
        end;
      finally
        CloseHandle(Handle);
      end;
    end;
  end;
end;

function CheckOwnedFile(const Path, ExpectedHash: String): String;
begin
  Result := '';
  if FileExists(Path) then
    if CompareText(GetSHA256OfFile(Path), ExpectedHash) <> 0 then
      Result := 'The target folder already contains a different file. It will not be replaced:' + #13#10 + Path;
end;

function CheckUpgradableFile(const Path, ExpectedHash, LegacyHash: String): String;
begin
  Result := CheckOwnedFile(Path, ExpectedHash);
  if (Result <> '') and (LegacyHash <> '') then
    if Pos('|' + Lowercase(GetSHA256OfFile(Path)) + '|', '|' + Lowercase(LegacyHash) + '|') > 0 then Result := '';
end;

function IsKnownLegacyMod(const Path: String): Boolean;
var Name: String;
begin
  // Every build of our own recorder is named local.armor_inspector_<version>.wotmod.
  // Any such file is ours, whichever build it is: it is moved to a backup, never refused.
  Name := Lowercase(ExtractFileName(Path));
  Result := FileExists(Path) and (Pos('local.armor_inspector_', Name) = 1) and
    (Copy(Name, Length(Name) - 6, 7) = '.wotmod');
end;

#include "generated\checks.iss"

function CheckGame(const Folder: String; CheckShortcut: Boolean): String;
var
  Doc, Shell, Shortcut: Variant;
  VersionText, ModPath, Viewer, LinkPath: String;
  Find: TFindRec;
begin
  Result := '';
  try
#ifdef TestBuild
    if Pos(Lowercase('{#TestRoot}\'), Lowercase(AddBackslash(ExpandFileName(Folder)))) <> 1 then begin
      Result := 'Test installer is restricted to its workspace fixture.';
      Exit;
    end;
#endif
    if not FileExists(AddBackslash(Folder) + 'version.xml') or
       not DirExists(AddBackslash(Folder) + 'res\packages') then begin
      Result := 'Select the World of Tanks root folder: version.xml and res\packages.';
      Exit;
    end;
    Doc := CreateOleObject('Msxml2.DOMDocument.6.0');
    Doc.async := False;
    Doc.resolveExternals := False;
    Doc.setProperty('ProhibitDTD', True);
    if not Doc.load(AddBackslash(Folder) + 'version.xml') then begin
      Result := 'Could not read version.xml of the selected game.';
      Exit;
    end;
    VersionText := Trim(Doc.selectSingleNode('/version.xml/version').text);
    if (VersionText <> 'v.2.4.0.1 #950') or
       (Trim(Doc.selectSingleNode('/version.xml/meta/realm').text) <> 'NA') then begin
      Result := 'This alpha build is for WoT PC NA 2.4.0.1 #950.' + #13#10 +
        'A different version or region was found in the selected folder.';
      Exit;
    end;
    if GameRunning then begin
      Result := 'Close World of Tanks before installing. The installer does not close the game itself.';
      Exit;
    end;
    ModPath := AddBackslash(Folder) + 'mods\2.4.0.1\';
    if FindFirst(ModPath + 'local.armor_inspector*.wotmod', Find) then begin
      try
        repeat
          if (CompareText(Find.Name, '{#ModName}') <> 0) and
             not IsKnownLegacyMod(ModPath + Find.Name) then begin
            Result := 'A different version of our recorder is already installed:' + #13#10 +
              ModPath + Find.Name + #13#10 + 'Remove it before installing this build.';
            Exit;
          end;
        until not FindNext(Find);
      finally
        FindClose(Find);
      end;
    end;
    Result := CheckOwnedFiles(Folder);
    if Result <> '' then Exit;
    if CheckShortcut and WizardIsTaskSelected('desktopicon') then begin
      Viewer := AddBackslash(Folder) + 'mods\configs\local.armor_inspector\Viewer.html';
      LinkPath := GetDesktopDir('') + '\Bullba Hits.lnk';
      if FileExists(LinkPath) then begin
        Shell := CreateOleObject('Shell.Application');
        Shortcut := Shell.NameSpace(GetDesktopDir('')).ParseName('Bullba Hits.lnk').GetLink;
        if not IsOurShortcut(Shortcut, Folder) then
          Result := 'The desktop already has a different shortcut with this name. Untick the shortcut option or rename the existing one.';
      end;
    end;
  except
    Result := 'Installation check did not finish: ' + GetExceptionMessage;
  end;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var Error: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then begin
    Error := CheckGame(WizardDirValue, False);
    Result := Error = '';
    if not Result then SuppressibleMsgBox(Error, mbError, MB_OK, IDOK);
  end;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := CheckGame(WizardDirValue, True);
end;

function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo,
  MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
begin
  Result := 'Game folder:' + NewLine + Space + WizardDirValue + NewLine + NewLine +
    'Viewer:' + NewLine + Space + AddBackslash(WizardDirValue) +
    'mods\configs\local.armor_inspector\Viewer.html' + NewLine + NewLine + MemoTasksInfo;
end;

procedure BackupLegacyMod(const ModsFolder, Version: String);
var OldPath, BackupPath, NewPath: String;
begin
  OldPath := ExpandConstant('{app}\mods\') + ModsFolder + '\local.armor_inspector_' + Version + '.wotmod';
  if not FileExists(OldPath) then Exit;
  NewPath := ExpandConstant('{app}\mods\2.4.0.1\{#ModName}');
  if not IsKnownLegacyMod(OldPath) or not FileExists(NewPath) or
      (CheckOwnedFile(NewPath, '{#ModHash}') <> '') then
    RaiseException('Could not verify the update files. The previous version is kept.');
  BackupPath := ExpandConstant('{app}\mods\configs\local.armor_inspector\installer\backups\') + Version + '\local.armor_inspector_' + Version + '.wotmod';
  // A different build of the same version number is kept apart under <version>-<hash8>; nothing is deleted unsaved.
  if FileExists(BackupPath) and (CompareText(GetSHA256OfFile(BackupPath), GetSHA256OfFile(OldPath)) <> 0) then
    BackupPath := ExpandConstant('{app}\mods\configs\local.armor_inspector\installer\backups\') + Version + '-' +
      Copy(GetSHA256OfFile(OldPath), 1, 8) + '\local.armor_inspector_' + Version + '.wotmod';
  if not ForceDirectories(ExtractFileDir(BackupPath)) then
    RaiseException('Could not create the mod backup folder.');
  if FileExists(BackupPath) then begin
    if not DeleteFile(OldPath) then RaiseException('Could not remove the previous mod version after the update.');
  end else if not RenameFile(OldPath, BackupPath) then
    RaiseException('Could not move the previous mod version to the backup.');
end;

procedure BackupLegacyModsIn(const ModsFolder: String);
var ModPath, Name: String; Find: TFindRec;
begin
  ModPath := ExpandConstant('{app}\mods\') + ModsFolder + '\';
  if not FindFirst(ModPath + 'local.armor_inspector_*.wotmod', Find) then Exit;
  try
    repeat
      Name := Find.Name;
      if (CompareText(Name, '{#ModName}') <> 0) and IsKnownLegacyMod(ModPath + Name) then
        BackupLegacyMod(ModsFolder, Copy(Name, Length('local.armor_inspector_') + 1, Length(Name) - Length('local.armor_inspector_') - Length('.wotmod')));
    until not FindNext(Find);
  finally
    FindClose(Find);
  end;
end;

// The current client folder first, then the previous client's folder (2.4.0.0): a build left there by the
// 2.4.0.0 installer is ours and goes to the same backups, so the game folder keeps one recorder.
procedure BackupAllLegacyMods;
begin
  BackupLegacyModsIn('2.4.0.1');
  BackupLegacyModsIn('2.4.0.0');
end;

procedure BackupViewerFolder(const Source, Dest: String);
var Find: TFindRec;
begin
  if not FindFirst(Source + '*', Find) then Exit;
  try
    repeat
      if (Find.Attributes and FILE_ATTRIBUTE_DIRECTORY) = 0 then begin
        ForceDirectories(Dest);
        CopyFile(Source + Find.Name, Dest + Find.Name, False);
      end;
    until not FindNext(Find);
  finally
    FindClose(Find);
  end;
end;

// The viewer files in our folder always belong to a previous build of ours. They are copied to a
// time-stamped backup before the new ones land; nothing is refused and nothing is lost.
procedure BackupViewerFiles;
var Base, Dest: String;
begin
  Base := ExpandConstant('{app}\mods\configs\local.armor_inspector\');
  if not FileExists(Base + 'Viewer.html') then Exit;
  Dest := Base + 'installer\backups\viewer-' + GetDateTimeString('yyyymmdd-hhnnss', '-', ':') + '\';
  if not ForceDirectories(Dest) then Exit;
  CopyFile(Base + 'Viewer.html', Dest + 'Viewer.html', False);
  BackupViewerFolder(Base + 'web\', Dest + 'web\');
  BackupViewerFolder(Base + 'web\vendor\', Dest + 'web\vendor\');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then BackupViewerFiles;
  if CurStep <> ssPostInstall then Exit;
  BackupAllLegacyMods;
  MigrateDesktopShortcut;
end;

function InitializeUninstall: Boolean;
var Error: String;
begin
  Result := False;
  try
    if GameRunning then begin
      SuppressibleMsgBox('Close World of Tanks before removing the mod.', mbError, MB_OK, IDOK);
      Exit;
    end;
    Error := CheckOwnedFile(ExpandConstant('{app}\mods\2.4.0.1\{#ModName}'), '{#ModHash}');
    if Error <> '' then begin
      SuppressibleMsgBox(Error, mbError, MB_OK, IDOK);
      Exit;
    end;
    Result := True;
  except
    SuppressibleMsgBox(GetExceptionMessage, mbError, MB_OK, IDOK);
  end;
end;
