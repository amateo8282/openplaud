import {
    differenceInDays,
    format,
    formatDistanceToNow,
    isThisYear,
    isToday,
    isYesterday,
} from "date-fns";
import type { DateTimeFormat } from "@/types/common";

export type { DateTimeFormat };

export function formatDateTime(
    date: Date | string,
    formatType: DateTimeFormat = "relative",
): string {
    const dateObj = typeof date === "string" ? new Date(date) : date;

    switch (formatType) {
        case "relative":
            return formatDistanceToNow(dateObj, { addSuffix: true });
        case "absolute":
            return format(dateObj, "MMM d, yyyy h:mm a");
        case "iso":
            return dateObj.toISOString();
        default:
            return formatDistanceToNow(dateObj, { addSuffix: true });
    }
}

/**
 * Bucket a date into a recording-list group label, ordered newest -> oldest:
 *   Today | Yesterday | This week | Earlier this month |
 *   <Month> (current year) | <Month YYYY> (previous years).
 * Returns a label only; does not re-sort.
 */
export function dateGroupLabel(date: Date | string): string {
    const d = typeof date === "string" ? new Date(date) : date;
    if (isToday(d)) return "Today";
    if (isYesterday(d)) return "Yesterday";
    const now = new Date();
    const days = differenceInDays(now, d);
    // `days >= 0` guard so future-dated items (clock skew) don't land
    // in "This week" and instead fall through to the month bucket.
    if (days >= 0 && days < 7) return "This week";
    if (
        d.getMonth() === now.getMonth() &&
        d.getFullYear() === now.getFullYear()
    ) {
        return "Earlier this month";
    }
    return isThisYear(d) ? format(d, "MMMM") : format(d, "MMMM yyyy");
}
