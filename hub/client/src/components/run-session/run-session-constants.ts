/** Split bounds mirror the clamp the preferences store commits, so the live drag
 *  preview can never show a width that will not be saved. */
export const SPLIT_MIN = 25;
export const SPLIT_MAX = 70;
export const SPLIT_DEFAULT = 40;
export const SPLIT_IDLE_FORM = 60;
/** One arrow-key press on the divider moves the split by this many percent. */
export const SPLIT_STEP = 2;
/** Terminal font bounds mirror the store's clamp, so A−/A+ can be disabled at
 *  the ends instead of clicking to no effect. */
export const FONT_MIN = 9;
export const FONT_MAX = 20;
