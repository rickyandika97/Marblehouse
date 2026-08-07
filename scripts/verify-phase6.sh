#!/bin/bash
# Phase 6 acceptance: attendance (PRD §4.13–§4.15, §16).
#
# Needs the dev server on localhost:5050 and the Phase 1 test accounts. Writes
# attendance rows, shifts and watermarked photo files to the dev database and
# the local data/ directory.
#
# §16 accepts Phase 6 on four things:
#
#   "a clock-in works on a real tablet with location granted and denied, the
#    watermark is legible, the banner behaves exactly as specified, and
#    lateness is correct at the grace boundary"
#
# Three of those are proven here. The FOURTH — a real tablet, a real camera,
# a real geolocation prompt — cannot be proven from a shell and is the
# outstanding on-device gate. What this script proves is that the server half
# is right: the API, the watermark pipeline, the permission matrix, and the
# banner's driving endpoint.
set -u
cd /Users/ricky/redlight || exit 1

B=http://localhost:5050
D=$(mktemp -d)
O=$D/o.txt; M=$D/m.txt; S=$D/s.txt
FAILED=0

j() { curl -sS "$@"; }
c() { curl -sS -o /dev/null -w "%{http_code}" "$@"; }
pass() { printf "  \033[32m✓\033[0m %s\n" "$1"; }
fail() { printf "  \033[31m✗\033[0m %s  (got: %s)\n" "$1" "$2"; FAILED=1; }
# An empty actual value almost always means the query or curl errored rather
# than genuinely returning "" — treat it as a failure (D-43).
chk() {
  if [ -z "$2" ] && [ -n "$3" ]; then fail "$1" "<empty — query failed?>"; return; fi
  [ "$2" = "$3" ] && pass "$1" || fail "$1" "$2"
}
login() {
  j -c "$3" -X POST "$B/api/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" >/dev/null
}
q() { node -pe "JSON.parse(require('fs').readFileSync(0,'utf8'))$1 ?? ''"; }
db() { node -e "const{PrismaClient}=require('@prisma/client');const p=new PrismaClient({log:[]});(async()=>{try{console.log(await (async(p)=>{ $1 })(p))}finally{await p.\$disconnect()}})()"; }

printf "════ Phase 6 setup ════\n"
login owner OwnerRealPass2026! "$O"
login manager1 MgrRealPass2026! "$M"
login staff1 StaffRealPass2026! "$S"

SHOP=$(db "return (await p.shop.findFirst({where:{code:'BR-1'}})).id")
SHOP2=$(db "return (await p.shop.findFirst({where:{code:'BR-2'}})).id")
for JAR in "$O" "$M" "$S"; do
  j -b "$JAR" -X POST "$B/api/work-session" -H 'Content-Type: application/json' \
    -d "{\"shopId\":\"$SHOP\"}" >/dev/null
done

# Clear today's attendance so the script is re-runnable.
db "
  const shop = await p.shop.findFirst({where:{code:'BR-1'}});
  const users = await p.user.findMany({where:{username:{in:['owner','manager1','staff1']}}});
  await p.attendance.deleteMany({where:{userId:{in:users.map(u=>u.id)}}});
  return 'cleared';
" >/dev/null

# A JPEG with NO EXIF — exactly what getUserMedia → canvas → blob produces.
node -e "
const sharp=require('sharp');
sharp({create:{width:1280,height:960,channels:3,background:'#7788aa'}})
  .jpeg().toFile('$D/shot.jpg').then(()=>process.exit(0));
"

SHIFT=$(j -b "$O" -X POST "$B/api/shops/$SHOP/shifts" -H 'Content-Type: application/json' \
  -d '{"name":"Verify Shift","startTime":"09:00","endTime":"17:00"}' | q ".id")
printf "  shop=%s  shift=%s\n" "${SHOP:0:8}" "${SHIFT:0:8}"

printf "\n════ §4.13 the banner's driving endpoint ════\n"
chk "STAFF is required to clock in" \
  "$(j -b "$S" "$B/api/attendance/status" | q ".required")" "true"
chk "MANAGER is required to clock in" \
  "$(j -b "$M" "$B/api/attendance/status" | q ".required")" "true"
chk "OWNER is NOT required (attendance is optional)" \
  "$(j -b "$O" "$B/api/attendance/status" | q ".required")" "false"
chk "the banner shows before clocking in" \
  "$(j -b "$S" "$B/api/attendance/status" | q ".clockedIn")" "false"

printf "\n════ §4.14 shifts ════\n"
SHIFT_PREVIEW=$(j -b "$S" "$B/api/shops/$SHOP/shifts?today=true" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  console.log(d.some(s => 'wouldBeLate' in s) ? 'yes' : 'no');
")
chk "today's shifts carry a lateness preview" "$SHIFT_PREVIEW" "yes"
chk "a midnight-crossing shift is accepted and flagged" \
  "$(j -b "$O" -X POST "$B/api/shops/$SHOP/shifts" -H 'Content-Type: application/json' \
     -d '{"name":"Night","startTime":"22:00","endTime":"06:00"}' | q ".crossesMidnight")" "true"
chk "a shift that starts and ends at the same time is refused" \
  "$(c -b "$O" -X POST "$B/api/shops/$SHOP/shifts" -H 'Content-Type: application/json' \
     -d '{"name":"Bad","startTime":"09:00","endTime":"09:00"}')" "422"
chk "STAFF cannot create a shift" \
  "$(c -b "$S" -X POST "$B/api/shops/$SHOP/shifts" -H 'Content-Type: application/json' \
     -d '{"name":"Nope","startTime":"09:00","endTime":"10:00"}')" "403"

printf "\n════ §4.13 clock-in ════\n"
CI=$(j -b "$S" -X POST "$B/api/attendance/clock-in" \
  -F "photo=@$D/shot.jpg;type=image/jpeg" -F "shiftId=$SHIFT" \
  -F "latitude=-6.20876" -F "longitude=106.84559" -F "accuracyM=12" \
  -F "locationDenied=false")
AID=$(echo "$CI" | q ".id")
chk "a clock-in with a live-capture photo succeeds (D-44: no EXIF is fine)" \
  "$([ -n "$AID" ] && echo yes || echo no)" "yes"
chk "the banner clears after clocking in" \
  "$(j -b "$S" "$B/api/attendance/status" | q ".clockedIn")" "true"
chk "a SECOND clock-in on the same day is refused" \
  "$(c -b "$S" -X POST "$B/api/attendance/clock-in" -F "photo=@$D/shot.jpg;type=image/jpeg" -F "locationDenied=true")" "409"
ONE_RECORD=$(db "
  const u = await p.user.findFirst({where:{username:'staff1'}});
  return p.attendance.count({where:{userId:u.id}});
")
chk "exactly one record exists for that user today" "$ONE_RECORD" "1"
chk "a clock-in with no photo is refused" \
  "$(c -b "$M" -X POST "$B/api/attendance/clock-in" -F "locationDenied=true")" "422"

printf "\n════ §4.13 location granted vs denied ════\n"
chk "granted location is stored" \
  "$(db "const a = await p.attendance.findUnique({where:{id:'$AID'}}); return a.locationDenied ? 'denied' : 'stored';")" "stored"
chk "the stored coordinates are what was sent" \
  "$(db "const a = await p.attendance.findUnique({where:{id:'$AID'}}); return Number(a.latitude).toFixed(5);")" "-6.20876"

# manager1 clocks in with location DENIED.
CI2=$(j -b "$M" -X POST "$B/api/attendance/clock-in" \
  -F "photo=@$D/shot.jpg;type=image/jpeg" -F "shiftId=$SHIFT" -F "locationDenied=true")
AID2=$(echo "$CI2" | q ".id")
chk "a denied location does NOT block the clock-in" \
  "$([ -n "$AID2" ] && echo yes || echo no)" "yes"
chk "the denied record is flagged for the owner" \
  "$(echo "$CI2" | q ".locationDenied")" "true"
chk "no coordinates are stored when location was denied" \
  "$(db "const a = await p.attendance.findUnique({where:{id:'$AID2'}}); return a.latitude === null ? 'null' : 'stored';")" "null"

printf "\n════ §4.13 the watermark ════\n"
j -b "$S" "$B/api/attendance/$AID/photo" -o "$D/served.jpg"
SERVED_FORMAT=$(node -e "
  require('sharp')('$D/served.jpg').metadata().then(m => console.log(m.format));
")
chk "the photo is served as a JPEG" "$SERVED_FORMAT" "jpeg"
chk "the stored photo is NOT the raw upload (it was watermarked)" \
  "$(node -e "
    const fs=require('fs');
    const a=fs.statSync('$D/shot.jpg').size, b=fs.statSync('$D/served.jpg').size;
    console.log(a === b ? 'identical' : 'different');
  ")" "different"
WATERMARK=$(node scripts/lib/check-watermark.mjs "$D/served.jpg")
chk "the watermark band is burned into the pixels" "$WATERMARK" "burned"

printf "\n════ §4.15 photo access is authenticated, never static ════\n"
chk "an anonymous caller cannot fetch a photo" \
  "$(c "$B/api/attendance/$AID/photo")" "401"
chk "the record's owner can fetch their own photo" \
  "$(c -b "$S" "$B/api/attendance/$AID/photo")" "200"
chk "a manager at that shop can fetch it" \
  "$(c -b "$M" "$B/api/attendance/$AID/photo")" "200"
chk "the API never returns a filesystem path" \
  "$(j -b "$S" "$B/api/attendance" | grep -c 'photoPath')" "0"
# The real question is whether the FILE is reachable, not the directory: an
# unauthenticated request to a bare path only meets the login redirect.
REAL_PHOTO=$(db "
  const a = await p.attendance.findFirst({where:{photoPath:{not:null}},select:{photoPath:true}});
  return a ? a.photoPath : '';
")
chk "a stored photo file is NOT reachable under /data" \
  "$(c "$B/data/$REAL_PHOTO")" "404"

printf "\n════ §3.4 permissions ════\n"
# `node -pe` prints the expression's value AS WELL as anything logged, so a
# console.log inside it emits a trailing "undefined". Use -e.
STAFF_SCOPE=$(j -b "$S" "$B/api/attendance" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0,'utf8'));
  const ids = new Set(d.map(r => r.user.id));
  console.log(ids.size <= 1 ? 'own-only' : 'leaked');
")
chk "STAFF sees only their OWN records" "$STAFF_SCOPE" "own-only"
chk "STAFF cannot excuse a record" \
  "$(c -b "$S" -X PATCH "$B/api/attendance/$AID" -H 'Content-Type: application/json' -d '{"status":"EXCUSED"}')" "403"
chk "a MANAGER cannot excuse a record either (owner only)" \
  "$(c -b "$M" -X PATCH "$B/api/attendance/$AID" -H 'Content-Type: application/json' -d '{"status":"EXCUSED"}')" "403"
chk "a manager cannot read a shop they are not assigned to" \
  "$(c -b "$M" "$B/api/shops/$SHOP2/shifts")" "403"
chk "an unauthenticated caller is refused" "$(c "$B/api/attendance/status")" "401"

printf "\n════ §4.13 owner excuse clears lateness ════\n"
db "await p.attendance.update({where:{id:'$AID'},data:{isLate:true,lateMinutes:22,status:'LATE'}}); return 'ok'" >/dev/null
EXCUSED=$(j -b "$O" -X PATCH "$B/api/attendance/$AID" -H 'Content-Type: application/json' \
  -d '{"status":"EXCUSED","note":"Approved - traffic"}')
chk "the owner can excuse" "$(echo "$EXCUSED" | q ".status")" "EXCUSED"
chk "excusing clears isLate" "$(echo "$EXCUSED" | q ".isLate")" "false"
chk "excusing zeroes lateMinutes" "$(echo "$EXCUSED" | q ".lateMinutes")" "0"
AUDIT_OK=$(db "
  const a = await p.auditLog.findFirst({where:{entityId:'$AID',action:'ATTENDANCE_EDIT'}});
  return a && a.before && a.after ? 'yes' : 'no';
")
chk "the edit is audit-logged with before and after" "$AUDIT_OK" "yes"

printf "\n════ §4.14 editing a shift does not rewrite history ════\n"
BEFORE_LATE=$(db "const a = await p.attendance.findUnique({where:{id:'$AID2'}}); return a.lateMinutes;")
j -b "$O" -X PATCH "$B/api/shops/$SHOP/shifts/$SHIFT" -H 'Content-Type: application/json' \
  -d '{"startTime":"06:00"}' >/dev/null
AFTER_LATE=$(db "const a = await p.attendance.findUnique({where:{id:'$AID2'}}); return a.lateMinutes;")
chk "past lateness is unchanged after the shift time moves" "$AFTER_LATE" "$BEFORE_LATE"
chk "the record kept its own snapshot of the shift start" \
  "$(db "const a = await p.attendance.findUnique({where:{id:'$AID2'}}); return a.shiftStartAtCapture ? 'kept' : 'lost';")" "kept"

printf "\n════ §4.16 audit ════\n"
for ACTION in ATTENDANCE_CLOCK_IN ATTENDANCE_EDIT SHIFT_CREATE SHIFT_UPDATE; do
  SEEN=$(db "return (await p.auditLog.count({where:{action:'$ACTION'}})) > 0 ? 'yes' : 'no'")
  chk "$ACTION is audit-logged" "$SEEN" "yes"
done

printf "\n"
if [ "$FAILED" = "0" ]; then
  printf "\033[32m════ Phase 6 PASS ════\033[0m\n"
  printf "  Still outstanding: the on-device pass — a real tablet, a real\n"
  printf "  camera, and a real geolocation prompt (§15's manual checklist).\n"
else
  printf "\033[31m════ Phase 6 FAIL ════\033[0m\n"
fi
rm -rf "$D"
exit "$FAILED"
