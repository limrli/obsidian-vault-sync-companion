"use strict";

const { Plugin, Notice, PluginSettingTab, Setting, Modal } = require("obsidian");
const { execFile, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_SETTINGS = {
  gitBinary: "git",
  repoPath: "",
  remoteName: "origin",
  branchName: "",
  autoPullOnStartup: true,
  autoSyncOnClose: true,
  showAutoSyncNotices: true,
  statusRefreshSeconds: 90,
  commitMessageTemplate: "vault sync: {{device}} {{timestamp}}",
  lastSuccessfulSyncAt: "",
  lastSeenCloseSyncResultAt: ""
};

const CLOSE_SYNC_RESULT_FILE = "close-sync-result.json";
const CLOSE_SYNC_PAYLOAD_FILE = "close-sync-payload.json";
const CLOSE_SYNC_WORKER_FILE = "close-sync-worker.ps1";
const CLOSE_SYNC_WORKER_SCRIPT = String.raw`param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadPath
)

$ErrorActionPreference = "Stop"

function Write-ResultFile {
  param(
    [bool]$Ok,
    [string]$Summary,
    [string]$ErrorMessage = ""
  )

  $result = [ordered]@{
    ok = $Ok
    summary = $Summary
    error = $ErrorMessage
    finishedAt = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
  }

  $result | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $script:ResultPath -Encoding UTF8
}

function Invoke-Git {
  param(
    [string[]]$Args
  )

  $output = & $script:GitBinary @Args 2>&1
  if ($LASTEXITCODE -ne 0) {
    $message = ($output | Out-String).Trim()
    if (-not $message) {
      $message = "git $($Args -join ' ') failed"
    }
    throw $message
  }
  return ($output | Out-String).Trim()
}

function Get-ConflictPreview {
  try {
    $conflicts = Invoke-Git @("diff", "--name-only", "--diff-filter=U")
    $lines = @($conflicts -split "\`r?\`n" | Where-Object { $_.Trim() } | Select-Object -First 5)
    if ($lines.Count -gt 0) {
      return ($lines -join ", ")
    }
  }
  catch {
    return ""
  }

  return ""
}

try {
  $payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
  $script:GitBinary = $payload.gitBinary
  $script:ResultPath = $payload.resultPath

  Set-Location -LiteralPath $payload.repoPath

  Invoke-Git @("fetch", $payload.remoteName, "--prune") | Out-Null
  $status = Invoke-Git @("status", "--porcelain=v1", "--branch")
  $header = (($status -split "\`r?\`n")[0]).Trim()
  $dirtyLines = @($status -split "\`r?\`n" | Select-Object -Skip 1 | Where-Object { $_.Trim() })
  $hasDirty = $dirtyLines.Count -gt 0
  $behindMatch = [regex]::Match($header, "behind\s+(\d+)")
  $behindCount = if ($behindMatch.Success) { [int]$behindMatch.Groups[1].Value } else { 0 }

  if ($hasDirty -and $behindCount -gt 0) {
    Write-ResultFile -Ok $false -Summary "close sync skipped" -ErrorMessage "remote changed while this device still had local edits; open Obsidian and run a manual sync"
    exit 0
  }

  $createdCommit = $false
  if ($hasDirty) {
    Invoke-Git @("add", "-A") | Out-Null
    $staged = Invoke-Git @("diff", "--cached", "--name-only")
    if ($staged) {
      Invoke-Git @("commit", "-m", $payload.commitMessage) | Out-Null
      $createdCommit = $true
    }
  }

  $statusAfterCommit = Invoke-Git @("status", "--porcelain=v1", "--branch")
  $header = (($statusAfterCommit -split "\`r?\`n")[0]).Trim()
  $aheadMatch = [regex]::Match($header, "ahead\s+(\d+)")
  $behindMatch = [regex]::Match($header, "behind\s+(\d+)")
  $aheadCount = if ($aheadMatch.Success) { [int]$aheadMatch.Groups[1].Value } else { 0 }
  $behindCount = if ($behindMatch.Success) { [int]$behindMatch.Groups[1].Value } else { 0 }

  if ($createdCommit -or $aheadCount -gt 0 -or $behindCount -gt 0) {
    Invoke-Git @("fetch", $payload.remoteName, "--prune") | Out-Null

    $statusAfterFetch = Invoke-Git @("status", "--porcelain=v1", "--branch")
    $headerAfterFetch = (($statusAfterFetch -split "\`r?\`n")[0]).Trim()
    $behindAfterFetch = [regex]::Match($headerAfterFetch, "behind\s+(\d+)")
    $behindAfterFetchCount = if ($behindAfterFetch.Success) { [int]$behindAfterFetch.Groups[1].Value } else { 0 }

    if ($behindAfterFetchCount -gt 0) {
      try {
        Invoke-Git @("pull", "--rebase", $payload.remoteName, $payload.branchName) | Out-Null
      }
      catch {
        $preview = Get-ConflictPreview
        $message = if ($createdCommit) {
          "remote and local changes could not be merged automatically. Your local work was already saved in commit '$($payload.commitMessage)'."
        }
        else {
          "remote and local changes could not be merged automatically."
        }

        if ($preview) {
          $message += " Conflicts: $preview."
        }

        $message += " Open Obsidian again, run git status in terminal, then finish with git rebase --continue."
        Write-ResultFile -Ok $false -Summary "close sync paused for manual rebase" -ErrorMessage $message
        exit 0
      }
    }

    Invoke-Git @("push", $payload.remoteName, $payload.branchName) | Out-Null
    $summary = if ($createdCommit -and $behindAfterFetchCount -gt 0) {
      "committed, merged remote changes, and pushed"
    }
    elseif ($createdCommit) {
      "committed and pushed"
    }
    else {
      "pushed existing local commits"
    }
    Write-ResultFile -Ok $true -Summary $summary
  }
  else {
    Write-ResultFile -Ok $true -Summary "no local work to sync on close"
  }
}
catch {
  Write-ResultFile -Ok $false -Summary "close sync failed" -ErrorMessage $_.Exception.Message
}
finally {
  if (Test-Path -LiteralPath $PayloadPath) {
    Remove-Item -LiteralPath $PayloadPath -Force -ErrorAction SilentlyContinue
  }
}`;

function normalizeOutput(value) {
  return (value || "").replace(/\r\n/g, "\n").trim();
}

const LARGE_CHANGE_WARNING_COUNT = 500;
const HUGE_CHANGE_WARNING_COUNT = 2000;

function formatTimestamp(date = new Date()) {
  const datePart = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
  const timePart = [
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0")
  ].join(":");
  return `${datePart} ${timePart}`;
}

function countListedFiles(text) {
  return normalizeOutput(text).split("\n").filter(Boolean).length;
}

function countConflictEntries(entries = []) {
  return entries.filter((line) => {
    const statusCode = String(line || "").slice(0, 2);
    return statusCode.includes("U") || statusCode === "AA" || statusCode === "DD";
  }).length;
}

function formatChangeSize(count) {
  if (count >= HUGE_CHANGE_WARNING_COUNT) {
    return "huge batch";
  }
  if (count >= LARGE_CHANGE_WARNING_COUNT) {
    return "large batch";
  }
  if (count > 0) {
    return "normal batch";
  }
  return "clean";
}

const SAFE_LOCAL_STATE_PATTERNS = [
  /^\.obsidian\/workspace(?:-mobile)?\.json$/i,
  /^\.obsidian\/workspaces\.json$/i,
  /^\.obsidian\/query\.json$/i,
  /^\.obsidian\/stats\.json$/i,
  /^\.obsidian\/view-count\.json$/i,
  /^\.obsidian\/webviewer\.json$/i,
  /^\.obsidian\/plugins\/recent-files-obsidian\/data\.json$/i,
  /^\.obsidian\/plugins\/obsidian-mindmap-nextgen\/data\.json$/i,
  /^\.obsidian\/plugins\/obsidian42-brat\/data\.json$/i,
  /^\.obsidian\/plugins\/various-complements\/histories\.json$/i,
  /^\.obsidian\/plugins\/vault-sync-companion\/data\.json$/i,
  /^\.obsidian\/plugins\/vault-sync-companion\/close-sync-[^/]+\.json$/i,
  /^\.stfolder\/.+/i
];

function extractDirtyPath(line) {
  const raw = String(line || "").slice(3).trim();
  const target = raw.includes(" -> ") ? raw.split(" -> ").pop() : raw;
  return target.replace(/^"|"$/g, "");
}

function isSafeLocalStatePath(filePath) {
  return SAFE_LOCAL_STATE_PATTERNS.some((pattern) => pattern.test(filePath));
}

function classifyDirtyEntries(entries = []) {
  const paths = entries.map(extractDirtyPath).filter(Boolean);
  const safeLocalOnlyPaths = paths.filter((filePath) => isSafeLocalStatePath(filePath));
  const contentPaths = paths.filter((filePath) => !isSafeLocalStatePath(filePath));
  return {
    paths,
    safeLocalOnlyPaths,
    contentPaths
  };
}

function formatPathPreview(paths, limit = 3) {
  if (!paths.length) {
    return "";
  }
  const shown = paths.slice(0, limit).join(", ");
  const remaining = paths.length - Math.min(paths.length, limit);
  return remaining > 0 ? `${shown} and ${remaining} more` : shown;
}

function parseBranchStatus(statusText) {
  const lines = normalizeOutput(statusText).split("\n").filter(Boolean);
  const header = lines[0] || "";
  const match = header.match(/^## ([^ ]+?)(?:\.\.\.([^ ]+))?(?: \[(.+)\])?$/);

  let branchName = "unknown";
  let trackingBranch = "";
  let ahead = 0;
  let behind = 0;

  if (match) {
    branchName = match[1];
    trackingBranch = match[2] || "";
    const details = match[3] || "";
    for (const part of details.split(",")) {
      const aheadMatch = part.match(/ahead (\d+)/);
      const behindMatch = part.match(/behind (\d+)/);
      if (aheadMatch) ahead = Number(aheadMatch[1]);
      if (behindMatch) behind = Number(behindMatch[1]);
    }
  }

  return {
    branchName,
    trackingBranch,
    ahead,
    behind,
    dirtyEntries: lines.slice(1)
  };
}

function buildSnapshotAdvice(snapshot) {
  if (snapshot.rebaseInProgress) {
    return {
      summary: "Sync is paused because Git is currently in the middle of a rebase.",
      details: [
        snapshot.conflictedCount > 0
          ? `${snapshot.conflictedCount} conflicted file(s) still need your decision.`
          : "Git is replaying local work on top of newer remote commits.",
        "Your notes are usually still safe because Git already created or replayed a local commit before stopping.",
        "Open terminal in this vault, run git status, resolve the listed files, then run git rebase --continue."
      ],
      cls: "vault-sync-companion-warning"
    };
  }

  if (snapshot.contentDirtyCount === 0 && snapshot.safeLocalOnlyDirtyCount > 0 && snapshot.behind > 0) {
    return {
      summary: "Only local-only state files are blocking this pull.",
      details: [
        `${snapshot.safeLocalOnlyDirtyCount} local state file(s) changed on this device.`,
        "These files are usually safe to discard before pulling newer notes from the other computer.",
        "Use Pull Latest and the plugin will automatically discard these local-only files before syncing."
      ],
      cls: "vault-sync-companion-warning"
    };
  }

  if (snapshot.dirtyCount > 0 && snapshot.behind > 0) {
    return {
      summary: "This vault has local edits and the other device has already pushed newer work.",
      details: [
        "Save and Push may need a rebase or manual conflict resolution.",
        snapshot.safeLocalOnlyDirtyCount > 0
          ? `${snapshot.safeLocalOnlyDirtyCount} changed file(s) look like local-only state, but ${snapshot.contentDirtyCount} file(s) still look like real content edits.`
          : `All ${snapshot.contentDirtyCount || snapshot.dirtyCount} changed file(s) look like real content edits.`,
        snapshot.dirtyCount >= LARGE_CHANGE_WARNING_COUNT
          ? `This is a ${snapshot.changeSizeLabel} with ${snapshot.dirtyCount} changed files, so the sync may take noticeably longer.`
          : `There are ${snapshot.dirtyCount} local changed files waiting to be saved.`,
        "If both devices changed the same note, Git may pause and wait for you to resolve conflicts."
      ],
      cls: "vault-sync-companion-warning"
    };
  }

  if (snapshot.dirtyCount >= HUGE_CHANGE_WARNING_COUNT) {
    return {
      summary: "This vault currently has a huge batch of local changes.",
      details: [
        `Git sees ${snapshot.dirtyCount} changed files.`,
        "Save and Push should still work, but staging and committing may take longer than usual.",
        "It is safest to let the operation finish before editing more notes or switching devices."
      ],
      cls: "vault-sync-companion-warning"
    };
  }

  if (snapshot.dirtyCount >= LARGE_CHANGE_WARNING_COUNT) {
    return {
      summary: "This vault currently has a large batch of local changes.",
      details: [
        `Git sees ${snapshot.dirtyCount} changed files.`,
        "Save and Push should work, but expect it to run longer than a small daily sync."
      ],
      cls: "vault-sync-companion-warning"
    };
  }

  if (snapshot.dirtyCount > 0) {
    return {
      summary: "You have local changes waiting to be saved into Git.",
      details: [
        `There are ${snapshot.dirtyCount} changed files in this vault.`,
        "Use Save and Push when you finish this session."
      ],
      cls: "vault-sync-companion-warning"
    };
  }

  if (snapshot.behind > 0) {
    return {
      summary: "The other device has newer commits ready to pull.",
      details: [
        `This vault is behind by ${snapshot.behind} commit(s).`,
        "Pull Latest is the safest next step before editing."
      ],
      cls: ""
    };
  }

  if (snapshot.ahead > 0) {
    return {
      summary: "This device already has local commits that have not been pushed yet.",
      details: [
        `This vault is ahead by ${snapshot.ahead} commit(s).`,
        "Use Save and Push to upload them."
      ],
      cls: "vault-sync-companion-warning"
    };
  }

  return {
    summary: "Workspace is clean. Pull Latest is safe before you start writing.",
    details: [],
    cls: ""
  };
}

class BeginnerGuideModal extends Modal {
  constructor(app) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Vault Sync Beginner Guide" });
    contentEl.createEl("p", {
      text: "This plugin helps two computers share one Obsidian vault through Git. You do not need to learn every Git command to use it safely."
    });

    contentEl.createEl("h3", { text: "What Each Action Does" });
    const actionList = contentEl.createEl("ul");
    [
      "Pull Latest: downloads the newest version from your remote repository before you start writing.",
      "If both computers changed different files, Pull Latest and Save and Push now let Git try an automatic merge first.",
      "Save and Push: saves all current vault changes, creates a Git commit, then uploads it to the remote repository.",
      "Open status panel: shows whether this computer is ahead, behind, or has unsaved changes.",
      "Local-only dirty examples: workspace.json, BRAT state, recent-files data, and Vault Sync Companion's own data.json settings file."
    ].forEach((text) => actionList.createEl("li", { text }));

    contentEl.createEl("h3", { text: "Simple Daily Workflow" });
    const workflowList = contentEl.createEl("ol");
    [
      "Open Obsidian and wait for the auto-pull notice.",
      "Write or edit your notes as usual.",
      "Before switching to your other computer, use Save and Push or let the close sync run.",
      "On the other computer, open Obsidian and let it pull first before editing."
    ].forEach((text) => workflowList.createEl("li", { text }));

    contentEl.createEl("h3", { text: "Notice Examples" });
    const noticeList = contentEl.createEl("ul");
    [
      "Auto pull started: the plugin has begun checking the remote repository.",
      "Already up to date: nothing new was found, so you can work normally.",
      "Pulled latest changes: this computer just received changes from the other computer.",
      "Auto pull skipped because local changes are present: this computer already has uncommitted edits, so it avoided overwriting anything.",
      "Pull will discard only local-only state files: only Obsidian local state changed, so the plugin can safely clean those files and continue pulling notes.",
      "Last close sync succeeded: the background sync after closing Obsidian completed successfully.",
      "Close sync skipped because remote changed: the other computer already pushed new work, so this plugin stopped and asked you to do a manual sync.",
      "Large batch detected: Git sees hundreds or thousands of changed files, so this save may take longer than usual.",
      "Sync paused because Git is rebasing: another device changed overlapping files, so Git needs manual conflict resolution before syncing can continue."
    ].forEach((text) => noticeList.createEl("li", { text }));

    contentEl.createEl("h3", { text: "What Ahead / Behind Means" });
    const explainList = contentEl.createEl("ul");
    [
      "Ahead 1: this computer has one local commit that has not been pushed yet.",
      "Behind 1: the remote repository has one newer commit from another computer.",
      "Dirty files: files changed in this vault but not saved into a Git commit yet."
    ].forEach((text) => explainList.createEl("li", { text }));

    contentEl.createEl("h3", { text: "When To Stop And Check" });
    const warningList = contentEl.createEl("ul");
    [
      "If you see rebase in progress, stop using the sync buttons and resolve it first.",
      "If both computers edited the same note before syncing, Git may ask for manual conflict resolution.",
      "If auto close sync is skipped because remote changed, open Obsidian again and run Pull Latest or Save and Push manually."
    ].forEach((text) => warningList.createEl("li", { text }));

    contentEl.createEl("h3", { text: "Large Import Example" });
    const importList = contentEl.createEl("ul");
    [
      "If you import thousands of notes at once, Save and Push may take longer because Git must scan and record every changed file.",
      "If the other computer only changed different files, the plugin now lets Git try the merge automatically.",
      "If the other computer also changed the vault, the plugin will warn that a rebase may happen before it pushes.",
      "If the rebase stops, your local commit is usually already created, so the notes are not lost. Finish the rebase first, then sync again."
    ].forEach((text) => importList.createEl("li", { text }));

    contentEl.createEl("h3", { text: "Why Pull Was Skipped" });
    const skippedList = contentEl.createEl("ul");
    [
      "If the plugin says local changes are present, it means this computer already changed some files and the plugin is avoiding silent overwrite.",
      "If those changed files are only local Obsidian state files, Pull Latest can now discard them automatically and continue.",
      "If real note files changed on this computer, the plugin will still stop and ask you to save or review them first."
    ].forEach((text) => skippedList.createEl("li", { text }));
  }
}

class SyncStatusModal extends Modal {
  constructor(app, plugin, initialSnapshot = null) {
    super(app);
    this.plugin = plugin;
    this.snapshot = initialSnapshot;
  }

  onOpen() {
    this.renderLoading("Loading repository status...");
    this.refresh();
  }

  renderLoading(text) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Vault Sync Status" });
    contentEl.createEl("p", { text });
  }

  renderError(error) {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Vault Sync Status" });
    contentEl.createEl("p", {
      text: error.message || String(error),
      cls: "vault-sync-companion-error"
    });
  }

  renderSnapshot() {
    const { contentEl } = this;
    const snapshot = this.snapshot;
    contentEl.empty();

    contentEl.createEl("h2", { text: "Vault Sync Status" });

    const rows = [
      ["Repository", snapshot.repoPath],
      ["Branch", snapshot.branchName],
      ["Tracking", snapshot.trackingBranch || `${snapshot.remoteName}/${snapshot.branchName}`],
      ["Remote", snapshot.remoteUrl || snapshot.remoteName],
      ["Dirty files", String(snapshot.dirtyCount)],
      ["Local-only dirty", String(snapshot.safeLocalOnlyDirtyCount)],
      ["Content dirty", String(snapshot.contentDirtyCount)],
      ["Conflicts", String(snapshot.conflictedCount)],
      ["Change size", snapshot.changeSizeLabel],
      ["Ahead / Behind", `up ${snapshot.ahead} / down ${snapshot.behind}`],
      ["Last sync", snapshot.lastSuccessfulSyncAt || "not recorded"]
    ];

    for (const [label, value] of rows) {
      const rowEl = contentEl.createDiv({ cls: "vault-sync-companion-row" });
      rowEl.createDiv({ text: label, cls: "vault-sync-companion-label" });
      rowEl.createDiv({ text: value, cls: "vault-sync-companion-value" });
    }

    const advice = buildSnapshotAdvice(snapshot);
    contentEl.createEl("p", {
      text: advice.summary,
      cls: advice.cls
    });

    if (advice.details.length > 0) {
      const detailList = contentEl.createEl("ul", { cls: "vault-sync-companion-list" });
      advice.details.forEach((text) => detailList.createEl("li", { text }));
    }

    if (snapshot.dirtyPreview.length > 0) {
      const previewHeading = contentEl.createEl("p", {
        text: "Changed file preview:",
        cls: "vault-sync-companion-label"
      });
      previewHeading.style.marginTop = "12px";
      const previewList = contentEl.createEl("ul", { cls: "vault-sync-companion-list" });
      snapshot.dirtyPreview.forEach((filePath) => previewList.createEl("li", { text: filePath }));
    }

    const actions = contentEl.createDiv({ cls: "vault-sync-companion-actions" });
    new Setting(actions)
      .addButton((button) =>
        button.setButtonText("Refresh")
          .onClick(async () => {
            await this.refresh();
          })
      )
      .addButton((button) =>
        button.setButtonText("Pull Latest")
          .setCta()
          .onClick(async () => {
            await this.plugin.runWithLock("pull-latest", async () => {
              await this.plugin.pullLatest({ interactive: true });
            });
            await this.refresh();
          })
      )
      .addButton((button) =>
        button.setButtonText("Save and Push")
          .onClick(async () => {
            await this.plugin.runWithLock("commit-and-push", async () => {
              await this.plugin.commitAndPush({ interactive: true });
            });
            await this.refresh();
          })
      )
      .addButton((button) =>
        button.setButtonText("Beginner Guide")
          .onClick(() => {
            this.plugin.openBeginnerGuide();
          })
      );
  }

  async refresh() {
    try {
      this.snapshot = await this.plugin.getRepositoryStatus();
      this.renderSnapshot();
    } catch (error) {
      this.renderError(error);
    }
  }
}

class VaultSyncCompanionSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Vault Sync Companion" });

    new Setting(containerEl)
      .setName("Git executable")
      .setDesc("Usually `git` is enough. Change this only if Git is not on PATH.")
      .addText((text) =>
        text.setPlaceholder("git")
          .setValue(this.plugin.settings.gitBinary)
          .onChange(async (value) => {
            this.plugin.settings.gitBinary = value.trim() || "git";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Repository path")
      .setDesc("Leave empty to use the current vault folder as the Git repository.")
      .addText((text) =>
        text.setPlaceholder("Leave empty for current vault")
          .setValue(this.plugin.settings.repoPath)
          .onChange(async (value) => {
            this.plugin.settings.repoPath = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remote name")
      .setDesc("Most vaults use `origin`.")
      .addText((text) =>
        text.setPlaceholder("origin")
          .setValue(this.plugin.settings.remoteName)
          .onChange(async (value) => {
            this.plugin.settings.remoteName = value.trim() || "origin";
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Branch name")
      .setDesc("Leave empty to use the current branch.")
      .addText((text) =>
        text.setPlaceholder("master")
          .setValue(this.plugin.settings.branchName)
          .onChange(async (value) => {
            this.plugin.settings.branchName = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto pull on startup")
      .setDesc("About 2 seconds after Obsidian opens, run a safe fast-forward pull.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoPullOnStartup)
          .onChange(async (value) => {
            this.plugin.settings.autoPullOnStartup = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto save and push on close")
      .setDesc("Best effort. On Windows this starts a background PowerShell worker when Obsidian closes.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.autoSyncOnClose)
          .onChange(async (value) => {
            this.plugin.settings.autoSyncOnClose = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Show auto-sync notices")
      .setDesc("Show popup notices when startup pull and close sync run automatically.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showAutoSyncNotices)
          .onChange(async (value) => {
            this.plugin.settings.showAutoSyncNotices = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Status refresh seconds")
      .setDesc("How often the status bar refreshes itself.")
      .addText((text) =>
        text.setPlaceholder("90")
          .setValue(String(this.plugin.settings.statusRefreshSeconds))
          .onChange(async (value) => {
            const parsed = Number(value);
            this.plugin.settings.statusRefreshSeconds = Number.isFinite(parsed) && parsed > 0 ? parsed : 90;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Commit message template")
      .setDesc("Supported variables: {{device}} {{timestamp}} {{branch}}")
      .addText((text) =>
        text.setPlaceholder("vault sync: {{device}} {{timestamp}}")
          .setValue(this.plugin.settings.commitMessageTemplate)
          .onChange(async (value) => {
            this.plugin.settings.commitMessageTemplate = value.trim() || DEFAULT_SETTINGS.commitMessageTemplate;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Open status panel")
      .setDesc("Check branch, dirty files, and ahead/behind counts.")
      .addButton((button) =>
        button.setButtonText("Open")
          .setCta()
          .onClick(() => this.plugin.openStatusModal())
      );

    new Setting(containerEl)
      .setName("Open beginner guide")
      .setDesc("See plain-language examples of what each sync action does.")
      .addButton((button) =>
        button.setButtonText("Open guide")
          .onClick(() => this.plugin.openBeginnerGuide())
      );
  }
}

module.exports = class VaultSyncCompanionPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.closeSyncTriggered = false;
    this.ensureCloseSyncWorker();

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("vault-sync-companion-status");
    this.statusBarEl.setText("Vault Sync: loading...");
    this.registerDomEvent(this.statusBarEl, "click", () => this.openStatusModal());

    this.addRibbonIcon("download", "Vault Sync: Pull latest", async () => {
      await this.runWithLock("pull-latest", async () => {
        await this.pullLatest({ interactive: true });
      });
    });

    this.addRibbonIcon("upload", "Vault Sync: Save and push", async () => {
      await this.runWithLock("commit-and-push", async () => {
        await this.commitAndPush({ interactive: true });
      });
    });

    this.addCommand({
      id: "vault-sync-open-status",
      name: "Vault Sync: Open status panel",
      callback: () => this.openStatusModal()
    });

    this.addCommand({
      id: "vault-sync-open-beginner-guide",
      name: "Vault Sync: Open beginner guide",
      callback: () => this.openBeginnerGuide()
    });

    this.addCommand({
      id: "vault-sync-pull-latest",
      name: "Vault Sync: Pull latest",
      callback: async () => {
        await this.runWithLock("pull-latest", async () => {
          await this.pullLatest({ interactive: true });
        });
      }
    });

    this.addCommand({
      id: "vault-sync-commit-and-push",
      name: "Vault Sync: Save and push",
      callback: async () => {
        await this.runWithLock("commit-and-push", async () => {
          await this.commitAndPush({ interactive: true });
        });
      }
    });

    this.addSettingTab(new VaultSyncCompanionSettingTab(this.app, this));

    this.registerDomEvent(window, "beforeunload", () => {
      this.triggerCloseSync().catch(() => {});
    });

    this.registerInterval(window.setInterval(async () => {
      await this.refreshStatus().catch(() => {});
    }, Math.max(15, Number(this.settings.statusRefreshSeconds) || 90) * 1000));

    await this.refreshStatus();
    await this.showCloseSyncResultNotice();

    if (this.settings.autoPullOnStartup) {
      window.setTimeout(async () => {
        this.notify("Vault Sync: auto pull started.", 5000, true);
        await this.runWithLock("startup-pull", async () => {
          await this.pullLatest({ interactive: false, startup: true });
        }).catch(() => {});
      }, 2000);
    }
  }

  onunload() {
    if (this.statusBarEl) {
      this.statusBarEl.removeClass("is-busy");
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    await this.refreshStatus().catch(() => {});
  }

  getVaultBasePath() {
    const adapter = this.app.vault?.adapter;
    const basePath = typeof adapter?.getBasePath === "function"
      ? adapter.getBasePath()
      : adapter?.basePath;

    if (!basePath) {
      throw new Error("This vault is not a local folder, so Git commands are unavailable.");
    }

    return basePath;
  }

  getPluginDir() {
    return path.join(this.getVaultBasePath(), ".obsidian", "plugins", this.manifest.id);
  }

  getCloseSyncResultPath() {
    return path.join(this.getPluginDir(), CLOSE_SYNC_RESULT_FILE);
  }

  getCloseSyncPayloadPath() {
    return path.join(this.getPluginDir(), CLOSE_SYNC_PAYLOAD_FILE);
  }

  getCloseSyncWorkerPath() {
    return path.join(this.getPluginDir(), CLOSE_SYNC_WORKER_FILE);
  }

  ensureCloseSyncWorker() {
    if (process.platform !== "win32") {
      return;
    }

    fs.writeFileSync(this.getCloseSyncWorkerPath(), CLOSE_SYNC_WORKER_SCRIPT, "utf8");
  }

  openStatusModal() {
    new SyncStatusModal(this.app, this, this.lastSnapshot || null).open();
  }

  openBeginnerGuide() {
    new BeginnerGuideModal(this.app).open();
  }

  notify(message, timeout = 6000, force = false) {
    if (force || this.settings.showAutoSyncNotices) {
      new Notice(message, timeout);
    }
  }

  async discardSafeLocalStateFiles(snapshot) {
    if (!snapshot.safeLocalOnlyPaths.length) {
      return;
    }

    await this.runGit(
      ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...snapshot.safeLocalOnlyPaths],
      snapshot.repoPath
    );
  }

  async listUnmergedFiles(repoPath) {
    try {
      const result = await this.runGit(["diff", "--name-only", "--diff-filter=U"], repoPath);
      return normalizeOutput(result.stdout).split("\n").filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  async buildRebaseConflictError(repoPath, { createdCommit = false, commitMessage = "", context = "sync" } = {}) {
    const conflictFiles = await this.listUnmergedFiles(repoPath);
    const preview = formatPathPreview(conflictFiles);
    const localSaveText = createdCommit
      ? `Your local changes were already saved in commit: ${commitMessage}.`
      : "Your local changes were not deleted, but sync could not continue automatically.";
    const actionText = context === "pull"
      ? "Open terminal in this vault, run git status, then resolve the rebase and finish with git rebase --continue before pulling again."
      : "Open terminal in this vault, run git status, then resolve the rebase and finish with git rebase --continue before pushing again.";
    const conflictText = conflictFiles.length
      ? ` Conflicted files: ${preview}.`
      : "";
    return new Error(
      `Sync paused because Git found overlapping edits that it could not merge automatically. ${localSaveText}${conflictText} ${actionText}`
    );
  }

  toUserFacingError(error, context, snapshot = this.lastSnapshot) {
    const raw = error?.message || String(error);
    const latest = snapshot || this.lastSnapshot || {};

    if (/rebase is already in progress/i.test(raw) || latest.rebaseInProgress) {
      const conflictHint = latest.conflictedCount > 0
        ? ` ${latest.conflictedCount} conflicted file(s) are still waiting.`
        : "";
      return new Error(
        `Git is currently rebasing, so Vault Sync stopped to protect your notes.${conflictHint} Open terminal in this vault, run git status, resolve the listed files, then run git rebase --continue.`
      );
    }

    if (/index\.lock/i.test(raw) || /Another git process seems to be running/i.test(raw)) {
      return new Error(
        "Git looks busy right now because another Git process or lock file is still active. Wait a moment, close other Git windows, then try again."
      );
    }

    if (/not a git repository/i.test(raw)) {
      return new Error(
        "Vault Sync could not find a Git repository for this vault. Check the repository path setting and make sure this Obsidian folder is really inside a Git repo."
      );
    }

    if (context === "pull-latest" && /ff-only/i.test(raw)) {
      return new Error(
        "Pull Latest could not do a fast-forward update. This usually means local history already differs from the remote, so review the status panel or terminal before trying again."
      );
    }

    return new Error(raw);
  }

  async fetchRemote(snapshot) {
    await this.runGit(["fetch", snapshot.remoteName, "--prune"], snapshot.repoPath);
    return await this.getRepositoryStatus();
  }

  async writeCloseSyncResult(result) {
    const resultPath = this.getCloseSyncResultPath();
    fs.writeFileSync(resultPath, JSON.stringify({
      ...result,
      finishedAt: result.finishedAt || formatTimestamp(new Date())
    }, null, 2), "utf8");
  }

  async runWithLock(label, action) {
    if (this.operationInProgress) {
      new Notice("Vault Sync is already running another operation. Please wait.");
      return;
    }

    this.operationInProgress = true;
    this.statusBarEl?.addClass("is-busy");
    this.statusBarEl?.setAttribute("data-label", label);

    try {
      return await action();
    } catch (error) {
      const friendlyError = this.toUserFacingError(error, label, this.lastSnapshot);
      new Notice(`Vault Sync: ${friendlyError.message || String(friendlyError)}`, 12000);
      throw friendlyError;
    } finally {
      this.operationInProgress = false;
      this.statusBarEl?.removeClass("is-busy");
      await this.refreshStatus().catch(() => {});
    }
  }

  async showCloseSyncResultNotice() {
    const resultPath = this.getCloseSyncResultPath();
    if (!fs.existsSync(resultPath)) {
      return;
    }

    try {
      const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
      if (!result || !result.finishedAt) {
        return;
      }

      if (this.settings.lastSeenCloseSyncResultAt === result.finishedAt) {
        return;
      }

      this.settings.lastSeenCloseSyncResultAt = result.finishedAt;
      await this.saveData(this.settings);

      if (result.ok) {
        this.notify(`Vault Sync: last close sync succeeded (${result.summary || "done"}).`, 7000, true);
      } else {
        this.notify(`Vault Sync: last close sync failed: ${result.error || "unknown error"}`, 10000, true);
      }
    } catch (_) {
      // Ignore invalid local worker result files.
    }
  }

  async triggerCloseSync() {
    if (process.platform !== "win32") {
      return;
    }

    if (!this.settings.autoSyncOnClose || this.closeSyncTriggered) {
      return;
    }

    this.closeSyncTriggered = true;

    if (this.operationInProgress) {
      await this.writeCloseSyncResult({
        ok: false,
        summary: "close sync skipped",
        error: "another Vault Sync operation was still running when Obsidian closed"
      });
      return;
    }

    let snapshot;
    try {
      snapshot = await this.getRepositoryStatus();
      snapshot = await this.fetchRemote(snapshot);
    } catch (error) {
      await this.writeCloseSyncResult({
        ok: false,
        summary: "close sync skipped",
        error: error.message || String(error)
      });
      return;
    }

    if (snapshot.rebaseInProgress) {
      await this.writeCloseSyncResult({
        ok: false,
        summary: "close sync skipped",
        error: "a rebase is in progress"
      });
      return;
    }

    const hasLocalWork = snapshot.dirtyCount > 0 || snapshot.ahead > 0;
    if (!hasLocalWork) {
      return;
    }

    const payload = {
      gitBinary: this.settings.gitBinary || "git",
      repoPath: snapshot.repoPath,
      remoteName: snapshot.remoteName,
      branchName: snapshot.branchName,
      commitMessage: this.buildCommitMessage(snapshot),
      resultPath: this.getCloseSyncResultPath(),
      requestedAt: formatTimestamp(new Date())
    };

    try {
      fs.writeFileSync(this.getCloseSyncPayloadPath(), JSON.stringify(payload, null, 2), "utf8");
      this.ensureCloseSyncWorker();
      this.notify(
        "Vault Sync: auto save and push started in background. Final result will appear next time you open Obsidian.",
        8000,
        true
      );

      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-ExecutionPolicy", "Bypass",
          "-File", this.getCloseSyncWorkerPath(),
          "-PayloadPath", this.getCloseSyncPayloadPath()
        ],
        {
          detached: true,
          stdio: "ignore",
          windowsHide: true
        }
      );

      child.unref();
    } catch (error) {
      await this.writeCloseSyncResult({
        ok: false,
        summary: "close sync failed to start",
        error: error.message || String(error)
      });
    }
  }

  buildCommitMessage(snapshot) {
    const template = this.settings.commitMessageTemplate || DEFAULT_SETTINGS.commitMessageTemplate;
    return template
      .replace(/\{\{device\}\}/g, os.hostname())
      .replace(/\{\{timestamp\}\}/g, formatTimestamp(new Date()))
      .replace(/\{\{branch\}\}/g, snapshot.branchName || "unknown");
  }

  async resolveRepositoryInfo() {
    const requestedPath = this.settings.repoPath || this.getVaultBasePath();
    const repoPath = normalizeOutput((await this.runGit(["rev-parse", "--show-toplevel"], requestedPath)).stdout);

    if (!repoPath) {
      throw new Error("No Git repository found. Make sure this vault is inside a Git repo.");
    }

    const detectedBranch = normalizeOutput((await this.runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoPath)).stdout);

    return {
      repoPath,
      branchName: this.settings.branchName || detectedBranch,
      remoteName: this.settings.remoteName || "origin"
    };
  }

  async getRepositoryStatus() {
    const info = await this.resolveRepositoryInfo();
    const gitStatus = await this.runGit(["status", "--porcelain=v1", "--branch"], info.repoPath);
    const parsed = parseBranchStatus(gitStatus.stdout);
    const classified = classifyDirtyEntries(parsed.dirtyEntries);

    let remoteUrl = "";
    try {
      remoteUrl = normalizeOutput((await this.runGit(["remote", "get-url", info.remoteName], info.repoPath)).stdout);
    } catch (_) {
      remoteUrl = "";
    }

    const gitDir = normalizeOutput((await this.runGit(["rev-parse", "--git-dir"], info.repoPath)).stdout);
    const gitDirPath = path.isAbsolute(gitDir) ? gitDir : path.join(info.repoPath, gitDir);
    const rebaseInProgress =
      fs.existsSync(path.join(gitDirPath, "rebase-merge")) ||
      fs.existsSync(path.join(gitDirPath, "rebase-apply"));

    const snapshot = {
      ...info,
      remoteUrl,
      branchName: info.branchName || parsed.branchName,
      trackingBranch: parsed.trackingBranch,
      ahead: parsed.ahead,
      behind: parsed.behind,
      dirtyCount: parsed.dirtyEntries.length,
      dirtyEntries: parsed.dirtyEntries,
      dirtyPaths: classified.paths,
      dirtyPreview: classified.paths.slice(0, 5),
      safeLocalOnlyDirtyCount: classified.safeLocalOnlyPaths.length,
      safeLocalOnlyPaths: classified.safeLocalOnlyPaths,
      contentDirtyCount: classified.contentPaths.length,
      contentDirtyPaths: classified.contentPaths,
      conflictedCount: countConflictEntries(parsed.dirtyEntries),
      changeSizeLabel: formatChangeSize(parsed.dirtyEntries.length),
      rebaseInProgress,
      lastSuccessfulSyncAt: this.settings.lastSuccessfulSyncAt || ""
    };

    this.lastSnapshot = snapshot;
    this.renderStatusBar(snapshot);
    return snapshot;
  }

  renderStatusBar(snapshot) {
    if (!this.statusBarEl) {
      return;
    }

    let text = `Vault Sync: ${snapshot.branchName}`;
    if (snapshot.rebaseInProgress) {
      text += snapshot.conflictedCount > 0
        ? ` | rebase ${snapshot.conflictedCount} conflict`
        : " | rebase";
    } else if (snapshot.dirtyCount > 0) {
      text += ` | ${snapshot.dirtyCount} dirty`;
      if (snapshot.contentDirtyCount === 0 && snapshot.safeLocalOnlyDirtyCount > 0) {
        text += " (local-state)";
      }
      if (snapshot.dirtyCount >= LARGE_CHANGE_WARNING_COUNT) {
        text += " (large)";
      }
    } else if (snapshot.ahead > 0 || snapshot.behind > 0) {
      text += ` | up ${snapshot.ahead} down ${snapshot.behind}`;
    } else {
      text += " | clean";
    }

    this.statusBarEl.setText(text);
    this.statusBarEl.setAttribute("aria-label", `${text}${snapshot.remoteUrl ? ` | ${snapshot.remoteUrl}` : ""}`);
  }

  async refreshStatus() {
    try {
      return await this.getRepositoryStatus();
    } catch (error) {
      if (this.statusBarEl) {
        this.statusBarEl.setText("Vault Sync: unavailable");
        this.statusBarEl.setAttribute("aria-label", error.message || String(error));
      }
      throw error;
    }
  }

  async pullLatest({ interactive = true, startup = false } = {}) {
    let snapshot = await this.getRepositoryStatus();

    if (snapshot.rebaseInProgress) {
      throw new Error("A rebase is already in progress. Finish or abort it first.");
    }

    if (interactive) {
      this.notify("Vault Sync: checking remote changes before pull...", 4000, true);
    }

    snapshot = await this.fetchRemote(snapshot);

    if (snapshot.dirtyCount > 0) {
      if (snapshot.contentDirtyCount === 0 && snapshot.safeLocalOnlyDirtyCount > 0 && snapshot.behind > 0) {
        const preview = formatPathPreview(snapshot.safeLocalOnlyPaths);
        if (interactive || startup) {
          this.notify(
            `Vault Sync: only local-only state files are blocking pull. Discarding ${snapshot.safeLocalOnlyDirtyCount} file(s): ${preview}`,
            10000,
            true
          );
        }

        await this.discardSafeLocalStateFiles(snapshot);
        snapshot = await this.getRepositoryStatus();
      }
    }

    if (snapshot.dirtyCount > 0) {
      if (snapshot.behind > 0 && snapshot.contentDirtyCount > 0) {
        let createdCommit = false;
        let commitMessage = "";
        if (interactive || startup) {
          this.notify(
            `Vault Sync: local notes changed on this device and the remote also changed. Creating a safety commit, then trying Git auto-merge for ${snapshot.contentDirtyCount} content file(s)...`,
            12000,
            true
          );
        }

        await this.runGit(["add", "-A"], snapshot.repoPath);
        const staged = await this.runGit(["diff", "--cached", "--name-only"], snapshot.repoPath);
        if (normalizeOutput(staged.stdout)) {
          commitMessage = this.buildCommitMessage(snapshot);
          await this.runGit(["commit", "-m", commitMessage], snapshot.repoPath);
          createdCommit = true;
        }

        try {
          await this.runGit(["pull", "--rebase", snapshot.remoteName, snapshot.branchName], snapshot.repoPath);
        } catch (_) {
          throw await this.buildRebaseConflictError(snapshot.repoPath, {
            createdCommit,
            commitMessage,
            context: "pull"
          });
        }

        this.settings.lastSuccessfulSyncAt = formatTimestamp(new Date());
        await this.saveData(this.settings);

        if (interactive || startup) {
          this.notify(
            createdCommit
              ? `Vault Sync: Git merged different-file changes automatically and pulled the latest version. Local work was saved as: ${commitMessage}`
              : "Vault Sync: Git merged different-file changes automatically and pulled the latest version.",
            10000,
            true
          );
        }

        return await this.refreshStatus();
      }

      if (interactive || startup) {
        const preview = formatPathPreview(snapshot.contentDirtyPaths.length ? snapshot.contentDirtyPaths : snapshot.dirtyPaths);
        const detail = snapshot.contentDirtyCount > 0
          ? `${snapshot.contentDirtyCount} file(s) look like real content edits`
          : `${snapshot.dirtyCount} local changed file(s) are present`;
        this.notify(
          `Vault Sync: pull skipped because ${detail}. Review or save them first. ${preview}`,
          12000,
          startup
        );
      }
      return snapshot;
    }

    if (interactive && snapshot.behind > 0) {
      this.notify(`Vault Sync: remote has ${snapshot.behind} newer commit(s). Pulling now...`, 5000, true);
    }

    const result = await this.runGit(
      ["pull", "--ff-only", snapshot.remoteName, snapshot.branchName],
      snapshot.repoPath
    );

    this.settings.lastSuccessfulSyncAt = formatTimestamp(new Date());
    await this.saveData(this.settings);

    const message = /Already up to date/i.test(result.stdout)
      ? "already up to date"
      : "pulled latest changes";

    if (interactive || startup) {
      this.notify(`Vault Sync: ${message}.`, 6000, startup);
    }

    return await this.refreshStatus();
  }

  async commitAndPush({ interactive = true } = {}) {
    let snapshot = await this.getRepositoryStatus();

    if (snapshot.rebaseInProgress) {
      throw new Error("A rebase is already in progress. Finish or abort it first.");
    }

    if (interactive) {
      this.notify("Vault Sync: checking repository state...", 4000, true);
    }

    snapshot = await this.fetchRemote(snapshot);

    if (snapshot.contentDirtyCount === 0 && snapshot.safeLocalOnlyDirtyCount > 0 && snapshot.behind > 0 && snapshot.ahead === 0) {
      if (interactive) {
        this.notify(
          "Vault Sync: only local-only state files changed on this device, so this action will switch to a safe pull instead of creating a noisy commit.",
          10000,
          true
        );
      }
      await this.discardSafeLocalStateFiles(snapshot);
      return await this.pullLatest({ interactive, startup: false });
    }

    if (interactive && snapshot.dirtyCount >= HUGE_CHANGE_WARNING_COUNT) {
      this.notify(
        `Vault Sync: detected ${snapshot.dirtyCount} changed files. This is a huge batch, so saving may take a while.`,
        10000,
        true
      );
    } else if (interactive && snapshot.dirtyCount >= LARGE_CHANGE_WARNING_COUNT) {
      this.notify(
        `Vault Sync: detected ${snapshot.dirtyCount} changed files. This is a large batch, so saving may be slower than usual.`,
        9000,
        true
      );
    }

    if (interactive && snapshot.dirtyCount > 0 && snapshot.behind > 0) {
      this.notify(
        `Vault Sync: another device already pushed ${snapshot.behind} newer commit(s). This save may need a rebase, and manual conflict resolution may be required.`,
        10000,
        true
      );
    }

    let createdCommit = false;
    let commitMessage = "";
    let stagedCount = 0;

    if (snapshot.dirtyCount > 0) {
      if (interactive) {
        this.notify("Vault Sync: staging local changes...", 5000, true);
      }
      await this.runGit(["add", "-A"], snapshot.repoPath);
      const staged = await this.runGit(["diff", "--cached", "--name-only"], snapshot.repoPath);
      stagedCount = countListedFiles(staged.stdout);
      if (normalizeOutput(staged.stdout)) {
        commitMessage = this.buildCommitMessage(snapshot);
        if (interactive) {
          this.notify(
            `Vault Sync: creating a local save point for ${stagedCount} file(s)...`,
            6000,
            true
          );
        }
        await this.runGit(["commit", "-m", commitMessage], snapshot.repoPath);
        createdCommit = true;
      }
    }

    if (interactive) {
      this.notify("Vault Sync: checking remote again before upload...", 5000, true);
    }
    snapshot = await this.fetchRemote(snapshot);

    try {
      if (interactive && snapshot.behind > 0) {
        this.notify(
          `Vault Sync: remote is still ahead by ${snapshot.behind} commit(s). Trying a rebase before push...`,
          8000,
          true
        );
      }
      await this.runGit(["pull", "--rebase", snapshot.remoteName, snapshot.branchName], snapshot.repoPath);
    } catch (_) {
      throw await this.buildRebaseConflictError(snapshot.repoPath, {
        createdCommit,
        commitMessage,
        context: "push"
      });
    }

    if (interactive) {
      this.notify("Vault Sync: pushing commits to the remote repository...", 5000, true);
    }
    await this.runGit(["push", snapshot.remoteName, snapshot.branchName], snapshot.repoPath);

    this.settings.lastSuccessfulSyncAt = formatTimestamp(new Date());
    if (createdCommit) {
      this.settings.lastCommitMessage = commitMessage;
    }
    await this.saveData(this.settings);

    if (interactive) {
      new Notice(
        createdCommit
          ? `Vault Sync: saved and pushed successfully. ${stagedCount || snapshot.dirtyCount} file(s) were included. ${commitMessage}`
          : "Vault Sync: no new local changes, push check completed."
      );
    }

    return await this.refreshStatus();
  }

  async runGit(args, cwd) {
    const gitBinary = this.settings.gitBinary || "git";

    return await new Promise((resolve, reject) => {
      execFile(
        gitBinary,
        args,
        {
          cwd,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true
        },
        (error, stdout, stderr) => {
          const normalizedStdout = normalizeOutput(stdout);
          const normalizedStderr = normalizeOutput(stderr);

          if (error) {
            reject(new Error(
              normalizedStderr ||
              normalizedStdout ||
              error.message ||
              `Git failed: ${gitBinary} ${args.join(" ")}`
            ));
            return;
          }

          resolve({
            stdout: normalizedStdout,
            stderr: normalizedStderr
          });
        }
      );
    });
  }
};
