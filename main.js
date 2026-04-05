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

try {
  $payload = Get-Content -LiteralPath $PayloadPath -Raw | ConvertFrom-Json
  $script:GitBinary = $payload.gitBinary
  $script:ResultPath = $payload.resultPath

  Set-Location -LiteralPath $payload.repoPath

  $status = Invoke-Git @("status", "--porcelain=v1", "--branch")
  $dirtyLines = @($status -split "\`r?\`n" | Select-Object -Skip 1 | Where-Object { $_.Trim() })
  $hasDirty = $dirtyLines.Count -gt 0

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
      Invoke-Git @("pull", "--rebase", $payload.remoteName, $payload.branchName) | Out-Null
    }

    Invoke-Git @("push", $payload.remoteName, $payload.branchName) | Out-Null
    $summary = if ($createdCommit) { "committed and pushed" } else { "pushed existing local commits" }
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
      ["Ahead / Behind", `up ${snapshot.ahead} / down ${snapshot.behind}`],
      ["Last sync", snapshot.lastSuccessfulSyncAt || "not recorded"]
    ];

    for (const [label, value] of rows) {
      const rowEl = contentEl.createDiv({ cls: "vault-sync-companion-row" });
      rowEl.createDiv({ text: label, cls: "vault-sync-companion-label" });
      rowEl.createDiv({ text: value, cls: "vault-sync-companion-value" });
    }

    let summary = "Workspace is clean. Pull latest is safe.";
    if (snapshot.rebaseInProgress) {
      summary = "A rebase is in progress. Finish or abort it in terminal before syncing again.";
    } else if (snapshot.dirtyCount > 0) {
      summary = "You have local changes. Use Save and Push when you finish this session.";
    }
    contentEl.createEl("p", {
      text: summary,
      cls: snapshot.rebaseInProgress || snapshot.dirtyCount > 0
        ? "vault-sync-companion-warning"
        : ""
    });

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

  notify(message, timeout = 6000, force = false) {
    if (force || this.settings.showAutoSyncNotices) {
      new Notice(message, timeout);
    }
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
      new Notice(`Vault Sync: ${error.message || String(error)}`, 8000);
      throw error;
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
      text += " | rebase";
    } else if (snapshot.dirtyCount > 0) {
      text += ` | ${snapshot.dirtyCount} dirty`;
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
    const snapshot = await this.getRepositoryStatus();

    if (snapshot.rebaseInProgress) {
      throw new Error("A rebase is already in progress. Finish or abort it first.");
    }

    if (snapshot.dirtyCount > 0) {
      if (interactive || startup) {
        this.notify("Vault Sync: auto pull skipped because local changes are present.", 7000, startup);
      }
      return snapshot;
    }

    await this.runGit(["fetch", snapshot.remoteName, "--prune"], snapshot.repoPath);
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
    const snapshot = await this.getRepositoryStatus();

    if (snapshot.rebaseInProgress) {
      throw new Error("A rebase is already in progress. Finish or abort it first.");
    }

    let createdCommit = false;
    let commitMessage = "";

    if (snapshot.dirtyCount > 0) {
      await this.runGit(["add", "-A"], snapshot.repoPath);
      const staged = await this.runGit(["diff", "--cached", "--name-only"], snapshot.repoPath);
      if (normalizeOutput(staged.stdout)) {
        commitMessage = this.buildCommitMessage(snapshot);
        await this.runGit(["commit", "-m", commitMessage], snapshot.repoPath);
        createdCommit = true;
      }
    }

    await this.runGit(["fetch", snapshot.remoteName, "--prune"], snapshot.repoPath);

    try {
      await this.runGit(["pull", "--rebase", snapshot.remoteName, snapshot.branchName], snapshot.repoPath);
    } catch (_) {
      throw new Error("Pull with rebase failed. Open terminal, run git status, and resolve the rebase.");
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
          ? `Vault Sync: committed and pushed. ${commitMessage}`
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
          maxBuffer: 10 * 1024 * 1024,
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
