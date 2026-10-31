# Line by Line — reference screens

Static HTML references for the three product screens. They define the look; the app wires the same structure to the API. No JavaScript, no external libraries; icons are inline SVG, photos and avatars are local PNGs in each `assets-*` folder. Font: Inter (Google Fonts).

Demo data only: the shop is the fictional "Bayside Auto Care", order #1042. No car brands, plates or VINs.

| Screen | File | Width | Who sees it |
|---|---|---|---|
| S1 — order page | `s1-customer/variant-S1.html` | 430 px (mobile) | the customer, opened from the QR code at drop-off |
| S2 — service desk | `s2-desk/variant-S2.html` | 1440 px | the service advisor |
| S2 — service desk, Pickup state | `s2-desk/variant-S2-pickup.html` | 1440 px | the service advisor at pickup |
| S3 — mechanic | `s3-mechanic/variant-S3.html` | 430 px (mobile) | the mechanic under the car |

Open any file directly in a browser. Widths are fixed, so the app needs its own responsive rules (S1 and S3 at 390–430 px).

## How to wire them

Every dynamic value carries `data-field="…"`. Grey placeholder bars are kept on purpose and carry `data-slot="…"`: they mark where secondary text goes, set in the same muted style. The tables below list each name and the data it expects.

Product rules the screens assume:
- Each approved line is its own PayPal authorization. A declined line has no PayPal order at all ("Not billed — no PayPal order").
- S1 shows "Approve with PayPal" and the green "Approved" strip at the same time, as in the reference. In the app the button hides once the line is approved.
- The Florida panel on S2 is computed in code: tolerance = min(max($10, 10 % of the estimate), $50), so $41.20 on a $412 estimate; new work always needs its own approval.
- Pickup fees are a formula placeholder (3.49 % + $0.49 per capture). In the app they come from the PayPal capture response.

### S1 — order page (`s1-customer/variant-S1.html`)

| Name | Data |
|---|---|
| `shop-name`, `order-id` | header: shop name, order number without "#" |
| `estimate-amount`, `estimate-status`, `estimate-charged` | estimate bar: amount of authorization 1, status word ("held"), charged so far |
| slot `mech-msg-1-l1`, `mech-msg-1-l2` | first mechanic message, two lines |
| `line2-photo`, `line2-voice-note`, `line2-voice-duration` | part photo URL, voice note URL, duration ("0:06") |
| `line2-thumb`, `line2-title`, `line2-price`, `line2-urgency` | line card: thumbnail, title, price from the shop price list, urgency ("Safety") |
| `line2-status`, `line2-auth-seq` | decision strip: status ("Approved") and PayPal authorization number (2) |
| slot `mech-msg-2-l1`, `mech-msg-2-l2` | second mechanic message |
| `line3-thumb`, `line3-title`, `line3-price`, `line3-urgency`, `line3-status` | second line card; status "Not billed" (the "— no PayPal order" tail is static) |
| slot `client-msg-l1`, `client-msg-l2` | customer reply |
| `approved-total`, `charged-so-far` | total bar |
| slot `consent-text` | electronic records consent line |
| `fl-rights-url` | link to "Florida estimate rights" |

### S2 — service desk (`s2-desk/variant-S2.html`)

| Name | Data |
|---|---|
| slot `nav-1..3`, `user-name`; `user-avatar` | top bar: menu labels, advisor name, avatar URL |
| slot `side-home`, `side-orders`, `side-vehicles`, `side-customers`, `side-reports`, `side-settings` | sidebar labels |
| `order-id` | order number in the title |
| slot `order-opened`, `order-advisor`, `vehicle`, `mileage`, `customer`, `customer-contact`, `dropoff`, `promised`, `technician`, `lift-assigned` | order details row (vehicle without brand or plate) |
| `line-no-1..3`, `line-desc-1..3`, `line-amount-1..3`, `line-status-1..3` | order lines; status pill AUTHORIZED or Not billed (no PayPal mark on Not billed) |
| `fl-tolerance`, `fl-max`, `fl-new-total`, `fl-verdict` | Florida panel: $41.20, $453.20, $598.00 (red when over the limit), verdict sentence |
| `hour-8` … `hour-17`, `lift-1..3` | schedule scale and lift names |
| `job-l1-a` … `job-l3-b` | schedule blocks: `left`/`width` = start/duration, colour = status |
| slot `l1a-title` … `l3b-sub` | text inside other jobs |
| `l2b-job`, `l2b-badge` | this order on Lift 2 and its "Confirmed by PayPal" badge |

### S2 — Pickup state (`s2-desk/variant-S2-pickup.html`)

Same top bar and sidebar as S2; the main area changes.

| Name | Data |
|---|---|
| `order-id`; slot `pickup-sub-1`, `pickup-sub-2` | title and two lines under it |
| `vehicle-image`; slot `vehicle-1..3` | body-type silhouette and vehicle details (no brand or plate) |
| `line-desc-1..3`, `line-amount-1..3`, `line-auth-1..3` | line label, authorized amount, "PayPal authorization N" or "no PayPal order" |
| `line-capture-1..3`, `captured-1`, `captured-2`, `released-1` | money bars: captured / released / not billed |
| `match-1..3` | invoice line = approved line checks |
| `invoice-total`, `paypal-fees`; slot `invoice-meta-1`, `invoice-meta-2` | total charged, PayPal fees per capture, net and invoice reference |

### S3 — mechanic (`s3-mechanic/variant-S3.html`)

| Name | Data |
|---|---|
| slot `mechanic-avatar`, `mechanic-name`, `order-ref` | header: avatar, mechanic name, shop and order |
| `photo` | part photo URL from the mechanic's camera |
| `waveform`, `voice-duration`, `transcript` | voice note: amplitudes (34 bars, played part dark), "0:06", transcript as spoken |
| `line-thumb`, `line-part`, `line-condition`, `line-price` | assembled line: thumbnail, part, condition ("worn thin"), price from the shop price list (set by code, not by the model) |
| `urgency`, `price-code` | urgency badge ("Safety" / "Can wait"), price list code ("BR-204") |
| slot `line-detail-1`, `line-detail-2` | line details |
| `send-state` | "Send to customer" button state: ready / sending / sent |
