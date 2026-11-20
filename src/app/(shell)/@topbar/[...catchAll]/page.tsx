// Catch-all for every slot path that has no @topbar/.../page.tsx of its own.
// On a soft nav Next keeps the slot's previous content unless the new route
// matches a slot page; this file returns null so routes without their own
// topbar action render an empty action area, matching the full-load default.
// Static slot pages still win per Next's route-match precedence (static
// beats dynamic beats catch-all), so none of the 13 existing slot pages is
// shadowed.
export default function CatchAll() {
  return null;
}
