import type { FingerprintProfile } from "../types.js";

interface FingerprintSeed {
  idPrefix: string;
  locale: string;
  timezone: string;
  viewportOptions: Array<{
    width: number;
    height: number;
  }>;
  userAgent: (chromeVersion: string) => string;
}

const chromeVersions = ["132.0.0.0", "133.0.0.0", "134.0.0.0", "135.0.0.0"];

const fingerprintSeeds: FingerprintSeed[] = [
  {
    idPrefix: "cn-win-office",
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
    viewportOptions: [
      { width: 1280, height: 720 },
      { width: 1366, height: 768 },
      { width: 1600, height: 900 }
    ],
    userAgent: (chromeVersion) =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  },
  {
    idPrefix: "cn-mac-retina",
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
    viewportOptions: [
      { width: 1440, height: 900 },
      { width: 1512, height: 982 }
    ],
    userAgent: (chromeVersion) =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  },
  {
    idPrefix: "cn-linux-ops",
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
    viewportOptions: [
      { width: 1366, height: 768 },
      { width: 1536, height: 864 }
    ],
    userAgent: (chromeVersion) =>
      `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  },
  {
    idPrefix: "hk-mac-hybrid",
    locale: "zh-HK",
    timezone: "Asia/Hong_Kong",
    viewportOptions: [
      { width: 1470, height: 956 },
      { width: 1728, height: 1117 }
    ],
    userAgent: (chromeVersion) =>
      `Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  },
  {
    idPrefix: "sg-win-hires",
    locale: "en-SG",
    timezone: "Asia/Singapore",
    viewportOptions: [
      { width: 1440, height: 810 },
      { width: 1920, height: 1080 }
    ],
    userAgent: (chromeVersion) =>
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`
  }
];

const defaultProfiles = fingerprintSeeds.flatMap((seed) =>
  chromeVersions.flatMap((chromeVersion) =>
    seed.viewportOptions.map((viewport) => ({
      id: `${seed.idPrefix}-${chromeVersion.split(".")[0]}-${viewport.width}x${viewport.height}`,
      userAgent: seed.userAgent(chromeVersion),
      locale: seed.locale,
      timezone: seed.timezone,
      viewport
    }))
  )
);

export class FingerprintPool {
  pick(excludeIds: string[] = []): FingerprintProfile {
    const excluded = new Set(excludeIds);
    const candidates = defaultProfiles.filter((profile) => !excluded.has(profile.id));
    const pool = candidates.length > 0 ? candidates : defaultProfiles;
    const selected = pool[Math.floor(Math.random() * pool.length)]!;

    return {
      ...selected,
      viewport: {
        ...selected.viewport
      }
    };
  }
}
