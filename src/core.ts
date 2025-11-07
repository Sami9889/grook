import { App, AwsLambdaReceiver } from "@slack/bolt";

export let receiver: AwsLambdaReceiver
export let app: App;
export let botId: string;

export async function init(env: Record<string, any>) {
    receiver = new AwsLambdaReceiver({
        signingSecret: env.SLACK_SIGNING_SECRET
    });
    app = new App({
        token: env.SLACK_BOT_TOKEN,
        receiver,
    });
    const authResponse = await app.client.auth.test();
    botId = authResponse.user_id ?? "";
}