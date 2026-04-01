export type MessageStatus = "sending" | "sent" | "delivered" | "failed";

export interface Message {
  id: string;
  text: string;
  sender: "user" | "ai";
  timestamp: string;
  status?: MessageStatus;
}
