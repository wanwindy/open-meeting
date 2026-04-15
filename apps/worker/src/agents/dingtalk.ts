import type { JoinParams } from "../types.js";
import type { Logger } from "../utils/logger.js";

import { BaseAgent } from "./base-agent.js";

export class DingtalkAgent extends BaseAgent {
  platform = "dingtalk" as const;

  constructor(logger: Logger) {
    super(logger);
  }

  async joinMeeting(params: JoinParams): Promise<void> {
    await this.performStandardJoin(params);
  }
}

