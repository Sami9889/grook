import { App, AwsLambdaReceiver } from "@slack/bolt";
import { env } from "cloudflare:workers";
import { WebClient } from "@slack/web-api";

export let receiver: AwsLambdaReceiver
export let app: App;
export let botId: string;
export const client = new WebClient(env.SLACK_BOT_TOKEN);
export let latestTs: string;

export async function init() {
    receiver = new AwsLambdaReceiver({
        signingSecret: env.SLACK_SIGNING_SECRET
    });
    app = new App({
        token: env.SLACK_BOT_TOKEN,
        receiver,
    });
    const authResponse = await client.auth.test();
    botId = authResponse.user_id ?? "";
}

export function assertString(data: unknown): asserts data is string {
    if (typeof data != "string") {
        throw new TypeError("")
    }
}

export function updateLatestTs(value: string) {
    latestTs = value
}