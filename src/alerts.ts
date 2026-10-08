// Alerts go to the stack's SNS topic. The topic feeds Slack through AWS
// Chatbot (Amazon Q Developer in chat applications) and emails AlertEmail.
//
// Chatbot shows only messages in its custom notification format, which reads
// poorly as an email, so each alert is published with a message per protocol:
// Chatbot's HTTPS subscription receives the "default" message, and email
// subscriptions receive the "email" message.

import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

const sns = new SNSClient({});

// Chatbot's limits for a custom notification's title and description.
const MAX_TITLE = 250;
const MAX_DESCRIPTION = 8000;
// SNS limits email subjects to 100 characters.
const MAX_SUBJECT = 100;

// The SNS message for an alert, exported for tests.
export function alertMessage(title: string, description: string): { Subject: string; Message: string } {
  const chatbot = {
    version: "1.0",
    source: "custom",
    content: {
      textType: "client-markdown",
      title: `:warning: ${title}`.slice(0, MAX_TITLE),
      description: description.slice(0, MAX_DESCRIPTION),
    },
  };
  return {
    Subject: title.slice(0, MAX_SUBJECT),
    Message: JSON.stringify({ default: JSON.stringify(chatbot), email: `${title}\n\n${description}` }),
  };
}

export async function alert(topicArn: string, title: string, description: string): Promise<void> {
  await sns.send(new PublishCommand({ TopicArn: topicArn, MessageStructure: "json", ...alertMessage(title, description) }));
}
