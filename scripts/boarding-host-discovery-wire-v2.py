from pathlib import Path

base=Path("scripts/boarding-host-discovery-wire.py").read_text()
marker="# Since boarding returned early, simplify dead ternaries enough to keep lint/typecheck clear without rewriting Pet Sitting."
insert='''one(\'\'\'  const gallery = boarding
    ? [
        ["/assets/stays/maya-rohan-profile.webp", "Host & guest pet"],
        ["/assets/stays/indiranagar-home.webp", "Living room & terrace"],
        ["/assets/stays/pet-guest-room.webp", "Guest pet room"],
      ]
    : [
        ["/assets/stays/sitter-profile.webp", "Sitter profile"],
        ["/assets/stays/sitter-care-update.webp", "Recent care update"],
      ];\'\'\',\'\'\'  const gallery = [
    ["/assets/stays/sitter-profile.webp", "Sitter profile"],
    ["/assets/stays/sitter-care-update.webp", "Recent care update"],
  ];\'\'\',\'remove dead Boarding gallery fixtures\')
one(\'\'\'  const amenities = boarding
    ? [
        ...caregiver.features,
        "Fenced terrace",
        "Pet-only sleeping area",
        "Power backup",
        "Vet within 2 km",
      ]
    : [
        ...caregiver.features,
        "Overnight stay",
        "Secure key handover",
        "Meal & medication log",
        "Emergency transport",
      ];\'\'\',\'\'\'  const amenities = [
    ...caregiver.features,
    "Overnight stay",
    "Secure key handover",
    "Meal & medication log",
    "Emergency transport",
  ];\'\'\',\'remove dead Boarding amenity fixtures\')
'''+marker
if marker not in base:
    raise SystemExit("Base Boarding host discovery script marker not found")
source=base.replace(marker,insert,1)
exec(compile(source,"boarding-host-discovery-wire-v2","exec"),{})
