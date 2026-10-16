import {
  BookOpen,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CloudSun,
  Hash,
  ListChecks,
  Mail,
  MailQuestion,
  Moon,
  Newspaper,
  Repeat,
  Sparkles,
  Sunrise,
  Target,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { presetOf } from "@/core/schedules/presets";
import type { BriefBlock, ScheduleInput, SchedulePreset } from "@/core/schedules/schedule";

/** One fine-line icon per kind of scheduled task: the preset, else what it mostly looks at. */
export const PRESET_ICONS: Record<SchedulePreset, LucideIcon> = {
  morning_brief: Sunrise,
  weekly_planning: CalendarRange,
  end_of_day: Moon,
  calendar_prep: CalendarClock,
  task_review: ListChecks,
  email_follow_up: Mail,
  knowledge_digest: BookOpen,
  habit_check_in: Repeat,
};

export const BLOCK_ICONS: Record<BriefBlock, LucideIcon> = {
  calendar: CalendarDays,
  email: Mail,
  needs_reply: MailQuestion,
  tasks: ListChecks,
  news: Newspaper,
  habits: Repeat,
  goals: Target,
  finance: Wallet,
  knowledge: BookOpen,
  weather: CloudSun,
  slack: Hash,
};

export function scheduleIcon(input: ScheduleInput): LucideIcon {
  const preset = input.configuration.preset ?? presetOf(input.configuration);
  if (preset) return PRESET_ICONS[preset];
  const blocks = input.configuration.blocks;
  return blocks.length === 1 ? BLOCK_ICONS[blocks[0]!] : Sparkles;
}
