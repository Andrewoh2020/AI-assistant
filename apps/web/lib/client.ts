import { createClient } from "@ai-assistant/api-client";

export const api = createClient("/api");

export const browserTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
