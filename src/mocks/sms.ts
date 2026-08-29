import type {
  SmsGateway,
  SmsMessage,
  SmsMessageStatus
} from "../audit/commitment";

export class MockSmsGateway implements SmsGateway {
  readonly sent: SmsMessage[] = [];

  constructor(private readonly status: SmsMessageStatus = "sent") {}

  async send(message: Pick<SmsMessage, "to" | "body">): Promise<SmsMessage> {
    const sentMessage: SmsMessage = {
      ...message,
      id: `mock-sms-${this.sent.length + 1}`,
      status: this.status
    };
    this.sent.push(sentMessage);
    return structuredClone(sentMessage);
  }
}
