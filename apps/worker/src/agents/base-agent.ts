import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright-core";

import { humanDelay, moveMouseSlightly } from "../anti-detect/human-behavior.js";
import { getPlatformConfig, resolveJoinUrl } from "../config/platform-config.js";
import type {
  FingerprintProfile,
  JoinParams,
  PlatformDeviceAssignment,
  PlatformType,
  ProxyEntry
} from "../types.js";
import type { Logger } from "../utils/logger.js";
import { waitFor } from "../utils/wait.js";

export abstract class BaseAgent {
  abstract platform: PlatformType;

  protected browser?: Browser;
  protected context?: BrowserContext;
  protected page?: Page;
  protected devices?: PlatformDeviceAssignment;
  protected dryRun = false;

  constructor(protected readonly logger: Logger) {}

  abstract joinMeeting(params: JoinParams): Promise<void>;

  async detectMeetingEnd(): Promise<void> {
    await waitFor(async () => this.hasMeetingEnded(), {
      timeoutMs: 12 * 60 * 60 * 1000,
      intervalMs: 5000
    });
  }

  async getParticipantCount(): Promise<number> {
    if (this.dryRun || !this.page) {
      return 0;
    }

    const selector = getPlatformConfig(this.platform).selectors.participantCount;

    if (!selector) {
      return 0;
    }

    const text = await this.page.locator(selector).first().textContent().catch(() => null);
    const matched = text?.match(/\d+/);
    return matched ? Number(matched[0]) : 0;
  }

  async init(
    fingerprint: FingerprintProfile,
    proxy: ProxyEntry,
    devices: PlatformDeviceAssignment,
    dryRun: boolean
  ): Promise<void> {
    this.devices = devices;
    this.dryRun = dryRun;

    if (dryRun) {
      this.logger.info("Skipping browser launch in dry-run mode", { platform: this.platform });
      return;
    }

    const launchOptions: LaunchOptions = {
      headless: false,
      executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
      env: {
        ...process.env,
        DISPLAY: devices.display,
        PULSE_SINK: devices.pulseSink,
        PULSE_SOURCE: devices.pulseSource
      },
      args: [
        `--window-size=${fingerprint.viewport.width},${fingerprint.viewport.height}`,
        "--use-fake-ui-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--disable-dev-shm-usage",
        "--no-sandbox"
      ]
    };

    if (proxy.enabled && proxy.server) {
      launchOptions.proxy = {
        server: proxy.server,
        username: proxy.username,
        password: proxy.password
      };
    }

    this.browser = await chromium.launch(launchOptions);
    this.context = await this.browser.newContext({
      userAgent: fingerprint.userAgent,
      locale: fingerprint.locale,
      timezoneId: fingerprint.timezone,
      viewport: fingerprint.viewport
    });
    this.page = await this.context.newPage();
  }

  async keepAlive(): Promise<void> {
    if (this.dryRun || !this.page) {
      return;
    }

    await moveMouseSlightly(this.page);
  }

  async cleanup(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;
  }

  async captureScreenshot(): Promise<Buffer> {
    if (this.dryRun || !this.page) {
      return Buffer.from("");
    }

    return this.page.screenshot({ fullPage: true });
  }

  isAlive(): boolean {
    return this.dryRun || Boolean(this.page && !this.page.isClosed());
  }

  async hasMeetingEnded(): Promise<boolean> {
    if (this.dryRun || !this.page) {
      return false;
    }

    const selector = getPlatformConfig(this.platform).selectors.meetingEndedBanner;

    if (!selector) {
      return false;
    }

    const count = await this.page.locator(selector).count().catch(() => 0);
    return count > 0;
  }

  protected async performStandardJoin(params: JoinParams): Promise<void> {
    if (this.dryRun) {
      this.logger.info("Dry-run join", {
        platform: this.platform,
        meetingId: params.endpoint.meetingId
      });
      return;
    }

    const page = this.requirePage();
    const config = getPlatformConfig(this.platform);
    const meetingUrl = resolveJoinUrl(this.platform, params.endpoint.meetingId, params.endpoint.meetingUrl);

    await page.goto(meetingUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000
    });

    await humanDelay();
    await this.clickIfVisible(config.selectors.browserEntryButton);
    await this.fillIfVisible(config.selectors.displayNameInput, params.endpoint.displayName);
    await this.fillIfVisible(config.selectors.meetingPasswordInput, params.endpoint.password ?? "");
    await this.clickRequired(config.selectors.joinButton);
    await humanDelay(1_500, 300);

    if (params.session.options.enableAudio) {
      await this.clickIfVisible(config.selectors.muteButton);
    }

    if (params.session.options.enableVideo) {
      await this.clickIfVisible(config.selectors.cameraButton);
    }
  }

  protected requirePage(): Page {
    if (!this.page) {
      throw new Error(`${this.platform} page has not been initialized`);
    }

    return this.page;
  }

  protected async clickRequired(selector: string): Promise<void> {
    const page = this.requirePage();
    await page.locator(selector).first().click({
      timeout: 15_000
    });
  }

  protected async clickIfVisible(selector?: string): Promise<boolean> {
    if (!selector || !this.page) {
      return false;
    }

    const locator = this.page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);

    if (!visible) {
      return false;
    }

    await locator.click({ timeout: 10_000 }).catch(() => undefined);
    return true;
  }

  protected async fillIfVisible(selector: string | undefined, value: string): Promise<boolean> {
    if (!selector || !value || !this.page) {
      return false;
    }

    const locator = this.page.locator(selector).first();
    const visible = await locator.isVisible().catch(() => false);

    if (!visible) {
      return false;
    }

    await locator.fill(value);
    return true;
  }
}
