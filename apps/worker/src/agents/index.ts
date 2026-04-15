import type { PlatformType } from "../types.js";
import type { Logger } from "../utils/logger.js";

import { BaseAgent } from "./base-agent.js";
import { DingtalkAgent } from "./dingtalk.js";
import { FeishuAgent } from "./feishu.js";
import { HuaweiAgent } from "./huawei.js";
import { LarkAgent } from "./lark.js";
import { TencentAgent } from "./tencent.js";
import { WelinkAgent } from "./welink.js";
import { ZhumuAgent } from "./zhumu.js";

export function createAgent(platform: PlatformType, logger: Logger): BaseAgent {
  switch (platform) {
    case "tencent":
      return new TencentAgent(logger);
    case "dingtalk":
      return new DingtalkAgent(logger);
    case "feishu":
      return new FeishuAgent(logger);
    case "lark":
      return new LarkAgent(logger);
    case "zhumu":
      return new ZhumuAgent(logger);
    case "huawei":
      return new HuaweiAgent(logger);
    case "welink":
      return new WelinkAgent(logger);
    default:
      throw new Error(`Unsupported platform: ${platform satisfies never}`);
  }
}
