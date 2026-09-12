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
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"

[Messages]
WelcomeLabel1=Установка Bullba Hits
WelcomeLabel2=Мод записывает попадания, а сохранённая история открывается в обычном браузере.%n%nПоддерживается World of Tanks PC NA 2.4.0.0 #945.%nПеред установкой закройте игру.
SelectDirLabel3=Выберите папку World of Tanks, в которой находятся version.xml и каталог res.
SelectDirBrowseLabel=Папка игры:
FinishedLabelNoIcons=Установка завершена. Мод начнёт записывать попадания после запуска игры.%n%nПросмотрщик доступен через Viewer.html в mods\configs\local.armor_inspector. После боя нажмите «Обновить» в просмотрщике.
FinishedLabel=Установка завершена. Мод начнёт записывать попадания после запуска игры.%n%nДля просмотра откройте ярлык Bullba Hits. После боя нажмите «Обновить» в просмотрщике.

[Tasks]
Name: desktopicon; Description: "Создать ярлык просмотрщика на рабочем столе"; GroupDescription: "Ярлык:"

[Files]
#include "generated\files.iss"

[Icons]
Name: "{code:GetDesktopDir}\Bullba Hits"; Filename: "{code:GetViewerLauncher}"; Parameters: "{code:GetViewerArguments}"; WorkingDir: "{app}\mods\configs\local.armor_inspector"; IconFilename: "{app}\mods\configs\local.armor_inspector\web\icon.ico"; Comment: "Bullba Hits — локальные попадания"; Tasks: desktopicon

[Run]
Filename: "{code:GetViewerLauncher}"; Parameters: "{code:GetViewerArguments}"; Description: "Открыть Bullba Hits"; Flags: shellexec postinstall skipifsilent unchecked

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
    RaiseException('Не удалось проверить, закрыта ли игра.');
  if Needed >= SizeOf(IDs) then
    RaiseException('Не удалось полностью прочитать список процессов.');
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
      Result := 'В целевой папке уже есть отличающийся файл. Он не будет заменён:' + #13#10 + Path;
end;

function CheckUpgradableFile(const Path, ExpectedHash, LegacyHash: String): String;
begin
  Result := CheckOwnedFile(Path, ExpectedHash);
  if (Result <> '') and (LegacyHash <> '') then
    if Pos('|' + Lowercase(GetSHA256OfFile(Path)) + '|', '|' + Lowercase(LegacyHash) + '|') > 0 then Result := '';
end;

function IsKnownLegacyMod(const Path: String): Boolean;
begin
  Result := False;
  if not FileExists(Path) then Exit;
  if CompareText(ExtractFileName(Path), 'local.armor_inspector_0.2.0.wotmod') = 0 then
    Result := CompareText(GetSHA256OfFile(Path), '89540876a8fe6dd5b9d06dba0b448ce840920e97356421bd85ccf86b50c5bcd5') = 0;
  if CompareText(ExtractFileName(Path), 'local.armor_inspector_0.2.1.wotmod') = 0 then
    Result := CompareText(GetSHA256OfFile(Path), '4399fbabb60033ccf092cfa104b82bb2da4418812e2214db9b80f5743dbcac2f') = 0;
  if CompareText(ExtractFileName(Path), 'local.armor_inspector_0.3.0.wotmod') = 0 then
    Result := CompareText(GetSHA256OfFile(Path), 'edb8dbb26094eeee81b2419a807b9955d464ff52191073338ae6aa098866edb0') = 0;
  if CompareText(ExtractFileName(Path), 'local.armor_inspector_0.3.1.wotmod') = 0 then
    Result := CompareText(GetSHA256OfFile(Path), '4ba06f7b5e2a03e11d0b0f8643bd7ef7661d4e86a9cbf97f9ca01a0599da3bd1') = 0;
  if CompareText(ExtractFileName(Path), 'local.armor_inspector_0.3.2.wotmod') = 0 then
    Result := CompareText(GetSHA256OfFile(Path), 'fb853c4f3ef2853d4af8511a26a25071d38f1861b54362fe05a044b3455a5791') = 0;
  if CompareText(ExtractFileName(Path), 'local.armor_inspector_0.4.0.wotmod') = 0 then
    Result := CompareText(GetSHA256OfFile(Path), '76568fe421459015d4a2bb4edef4975e8227df4226e9eea116cfc9ae774b592c') = 0;
  if CompareText(ExtractFileName(Path), 'local.armor_inspector_0.5.0.wotmod') = 0 then
    Result := CompareText(GetSHA256OfFile(Path), '13eb6b242484a90e247b0c59c12e14de5044e1e269da822d72e24d5aa75cc29a') = 0;
  if CompareText(ExtractFileName(Path), 'local.armor_inspector_0.5.1.wotmod') = 0 then
    Result := CompareText(GetSHA256OfFile(Path), '83b0a811756b9bbe26bd1b2a6922e1ec14e33e59adb140c2311f62591748973b') = 0;
  if CompareText(ExtractFileName(Path), 'local.armor_inspector_0.6.0.wotmod') = 0 then
    Result := CompareText(GetSHA256OfFile(Path), 'b243712e0962a8340353e0966e9c8367d235c5bb9f6e8d674f68a58614a4b4da') = 0;
  if CompareText(ExtractFileName(Path), 'local.armor_inspector_0.5.2.wotmod') = 0 then
    Result := CompareText(GetSHA256OfFile(Path), 'e9ff6ad1318fe6377bc91af80427d45d0bf6c1fc89c36e773561c257713768a1') = 0;
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
      Result := 'Выберите корневую папку World of Tanks: нужны version.xml и res\packages.';
      Exit;
    end;
    Doc := CreateOleObject('Msxml2.DOMDocument.6.0');
    Doc.async := False;
    Doc.resolveExternals := False;
    Doc.setProperty('ProhibitDTD', True);
    if not Doc.load(AddBackslash(Folder) + 'version.xml') then begin
      Result := 'Не удалось прочитать version.xml выбранной игры.';
      Exit;
    end;
    VersionText := Trim(Doc.selectSingleNode('/version.xml/version').text);
    if (VersionText <> 'v.2.4.0.0 #945') or
       (Trim(Doc.selectSingleNode('/version.xml/meta/realm').text) <> 'NA') then begin
      Result := 'Эта alpha-сборка предназначена для WoT PC NA 2.4.0.0 #945.' + #13#10 +
        'В выбранной папке обнаружена другая версия или регион.';
      Exit;
    end;
    if GameRunning then begin
      Result := 'Закройте World of Tanks перед установкой. Установщик не завершает игру автоматически.';
      Exit;
    end;
    ModPath := AddBackslash(Folder) + 'mods\2.4.0.0\';
    if FindFirst(ModPath + 'local.armor_inspector*.wotmod', Find) then begin
      try
        repeat
          if (CompareText(Find.Name, '{#ModName}') <> 0) and
             not IsKnownLegacyMod(ModPath + Find.Name) then begin
            Result := 'Уже установлена другая версия нашего регистратора:' + #13#10 +
              ModPath + Find.Name + #13#10 + 'Удалите её перед установкой этой сборки.';
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
          Result := 'На рабочем столе уже есть другой ярлык с таким именем. Снимите флажок создания ярлыка или переименуйте существующий.';
      end;
    end;
  except
    Result := 'Проверка установки не завершена: ' + GetExceptionMessage;
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
  Result := 'Папка игры:' + NewLine + Space + WizardDirValue + NewLine + NewLine +
    'Просмотрщик:' + NewLine + Space + AddBackslash(WizardDirValue) +
    'mods\configs\local.armor_inspector\Viewer.html' + NewLine + NewLine + MemoTasksInfo;
end;

procedure BackupLegacyMod(const Version: String);
var OldPath, BackupPath, NewPath: String;
begin
  OldPath := ExpandConstant('{app}\mods\2.4.0.0\local.armor_inspector_') + Version + '.wotmod';
  if not FileExists(OldPath) then Exit;
  NewPath := ExpandConstant('{app}\mods\2.4.0.0\{#ModName}');
  if not IsKnownLegacyMod(OldPath) or not FileExists(NewPath) or
      (CheckOwnedFile(NewPath, '{#ModHash}') <> '') then
    RaiseException('Не удалось подтвердить файлы обновления. Предыдущая версия сохранена.');
  BackupPath := ExpandConstant('{app}\mods\configs\local.armor_inspector\installer\backups\') + Version + '\local.armor_inspector_' + Version + '.wotmod';
  if not ForceDirectories(ExtractFileDir(BackupPath)) then
    RaiseException('Не удалось создать папку резервной копии мода.');
  if FileExists(BackupPath) then begin
    if not IsKnownLegacyMod(BackupPath) then
      RaiseException('Резервная копия предыдущей версии изменена.');
    if not DeleteFile(OldPath) then RaiseException('Не удалось убрать прежнюю версию мода после обновления.');
  end else if not RenameFile(OldPath, BackupPath) then
    RaiseException('Не удалось переместить прежнюю версию мода в резервную копию.');
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep <> ssPostInstall then Exit;
  BackupLegacyMod('0.2.0');
  BackupLegacyMod('0.2.1');
  BackupLegacyMod('0.3.0');
  BackupLegacyMod('0.3.1');
  BackupLegacyMod('0.3.2');
  BackupLegacyMod('0.4.0');
  BackupLegacyMod('0.5.0');
  BackupLegacyMod('0.5.1');
  BackupLegacyMod('0.5.2');
  BackupLegacyMod('0.6.0');
  MigrateDesktopShortcut;
end;

function InitializeUninstall: Boolean;
var Error: String;
begin
  Result := False;
  try
    if GameRunning then begin
      SuppressibleMsgBox('Закройте World of Tanks перед удалением мода.', mbError, MB_OK, IDOK);
      Exit;
    end;
    Error := CheckOwnedFile(ExpandConstant('{app}\mods\2.4.0.0\{#ModName}'), '{#ModHash}');
    if Error <> '' then begin
      SuppressibleMsgBox(Error, mbError, MB_OK, IDOK);
      Exit;
    end;
    Result := True;
  except
    SuppressibleMsgBox(GetExceptionMessage, mbError, MB_OK, IDOK);
  end;
end;
