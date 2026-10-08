// Alerts go to the stack's SNS topic, which emails AlertEmail when set.

import { PublishCommand, SNSClient } from "@aws-sdk/client-sns";

const sns = new SNSClient({});

export async function alert(topicArn: string, subject: string, message: string): Promise<void> {
  // SNS limits subjects to 100 characters.
  await sns.send(new PublishCommand({ TopicArn: topicArn, Subject: subject.slice(0, 100), Message: message }));
}
