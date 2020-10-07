const { IncomingWebhook } = require('@slack/webhook');

const emoji_Incoming = ':envelope_with_arrow:'

// Initialize
const webhook = new IncomingWebhook(process.env.SLACK_WEBHOOK_URL);

module.exports = {
    sendMessage: async (message, emoji) => {
        if (process.env.SLACK_CHANNEL) await webhook.send({
            text: message,
            channel: process.env.SLACK_CHANNEL,
            as_user: false,
            icon_emoji: emoji || emoji_Incoming,
            username: process.env.SLACK_USERNAME || 'AWS SES'
        });
    }
}