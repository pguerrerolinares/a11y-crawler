# Design Reference — AccessScan

Source: `design.pen` (Pencil MCP)

## Design System

**Theme**: Dark nav/hero + white content areas, shadcn/ui components
**Font**: System sans-serif (`$font-sans`)
**Colors**: Standard shadcn variables — `$background`, `$foreground`, `$primary`, `$border`, `$muted`, `$card`, etc.
**Corner radius**: `$radius` (shadcn default)

### Components (reusable)

| Component | ID | Notes |
|---|---|---|
| Button/Primary | `4CeT2` | `$primary` bg, icon + label, `gap:8`, `padding:[10,16]` |
| Button/Secondary | `dH66H` | `$secondary` bg |
| Button/Outline | `xyaCv` | `$background` bg + `$border` stroke |
| Button/Ghost | `HRiYD` | No bg |
| Button/Destructive | `rCRjr` | `$destructive` bg, trash icon |
| Card | `Mf8Rq` | `cornerRadius:8`, `$card` fill, `$border` stroke, vertical layout: Header / Content (slot) / Footer |
| Badge/Default | `lV2b8` | `$primary` bg, `cornerRadius:100`, `padding:[4,10]`, `fontSize:12`, `fontWeight:600` |
| Badge/Secondary | `2fMnW` | `$secondary` bg |
| Badge/Outline | `hZSAN` | Stroke only |
| Badge/Destructive | `rLMcx` | `#FEE2E2` bg, `#DC2626` text ("Critical") |
| Badge/Warning | `sAR5Q` | `#FEF3C7` bg, `#D97706` text ("Warning") |
| Badge/Success | `5u9z6` | `#DCFCE7` bg, `#16A34A` text ("Pass") |
| Input | `gCSwS` | Search icon + placeholder, `height:40`, `$border` stroke |
| Progress | `daY8L` | `$secondary` track, `$primary` fill, `cornerRadius:100`, `height:8` |
| Separator | `Vwf0r` | `$border` fill, `height:1` |
| Tab/Active | `0PmY9` | `$background` fill + shadow |
| Tab/Inactive | `bPPhk` | No fill, `$muted-foreground` text |
| TabsList | `h13QC` | `$muted` bg, `cornerRadius:8`, `padding:4` |
| Avatar | `Il9ca` | Circle `36x36`, `$muted` bg, initials |

---

## Pages — Desktop (1440px)

### 1. Accessibility Analyzer (Home) — `cHDwk`

**Sections (vertical layout):**

1. **Navigation Bar** (`0ZvuC`) — `height:56`, `$background`, bottom border
   - Logo "AccessScan" left, nav links (Scanner, Reports, Logs), avatar right
2. **Hero Scanner Section** (`VqSCO`) — `padding:[56,120]`, centered
   - Title: "Analyze Website Accessibility"
   - Subtitle: "Find, prioritize and fix WCAG compliance issues"
   - URL input field + "Scan Now" primary button
   - Depth/max pages options row
3. **Results Summary Cards** (`mkuWf`) — `padding:[40,120]`, `gap:24`
   - Title: "Scan Results"
   - 4 stat cards in a row: Issues Found (with badge count), Warnings, Passed, WCAG Score (with circular progress)
4. **Error Details Section** (`Knr3T`) — `padding:[0,120,32,120]`, `gap:24`
   - Table with columns: Issue, Type (badge), Impact (badge), WCAG, Element, Actions (View)
   - Pagination row at bottom
5. **Report Generation Section** (`XoeZd`) — `padding:[0,120,48,120]`
   - Title: "Accessibility Report"
   - Stats: pages scanned, issues, scan duration
   - Export buttons: "Download PDF Report", "Export CSV"
6. **Footer** (`8M7eH`) — `$footer-bg`, `padding:[48,120,32,120]`
   - Logo + tagline left
   - 4 column link grid: Product, Resources, Company
   - Social icons row, copyright

### 2. Reports Page — `2L48O`

**Sections:**

1. **Navigation** (`8TYYZ`) — Same pattern as home
2. **Main Content** (`xXtcA`) — `padding:[40,120]`, `gap:32`
   - Header: "Reports" title + subtitle + "New Scan" button + "Export All" button
   - **Summary Cards Row** (4 cards):
     - Last Scan: date + "Scan completed" badge
     - Critical Issues: count + priority breakdown link
     - Pages Failing: count/total + progress bar
     - Issues Fixed: count + percentage
   - **Scan History Table**:
     - Columns: Website, Date, WCAG Score, Critical, Warnings, Status (badge), Actions
     - Status badges: colored (green=pass, red=failing, yellow=needs work)
     - Pagination
3. **Footer** (`Y9FCu`) — Same footer pattern

### 3. Logs Page — `VF4ag`

**Sections:**

1. **Navigation** (`DrVy5`) — Same + "Active" badge on Logs link
2. **Logs Main** (`jEn9l`) — `padding:[40,120]`, `gap:24`
   - Header: "Application Logs" + subtitle + "Active Only" toggle + "Export Logs" button
   - **Stat Cards Row** (4 cards):
     - Total Requests: 124,847 + trend percentage
     - Avg Response: 342ms + comparison
     - Error Rate: 18 + percentage
     - Avg Response: 142ms + p95 value
   - **Filters Section**: Two rows of filters
     - Row 1: Method (multi-select), IP, Date Range, HTTP Status (select), All Statuses
     - Row 2: IP Address, Endpoint, Request Host, Params, Response Body
     - Active tags: Status 200, Method GET, Last 24h
   - **Request Logs Table**:
     - Columns: Timestamp, Method (colored badge: GET=green, POST=blue, PATCH=yellow, DELETE=red), Endpoint, Proxy, Pro, Status (colored badge), IP Address, Response (ms)
     - Pagination
3. **Footer** (`w0Raz`) — Same footer pattern

### 4. Log Detail Modal — Overview tab — `R0aHu`

**Overlay**: `#00000066` background, centered modal `860x780`, `cornerRadius:12`

**Layout:**
- **Header**: Globe icon + "Request Details" + endpoint + status badge (200 OK) + method badge (GET) + duration
- **Left Sidebar** (tabs vertical): Overview, Request, Response, Headers, Timing, User Agent
- **Content Area** — Overview tab:
  - Timestamp, Method, IP Address, HTTP Status (badge), Duration, Response Size
  - UserAgent string
  - Request section: Query Parameters list, Request Body (code block with dark bg)
- **Footer**: "Copy as cURL" + "Copy Request ID" buttons + "Close" button

### 5. Log Detail — Request tab — `BUAH5`

- Query parameters displayed as key-value list
- Request body shown in dark code block with syntax highlighting

### 6. Log Detail — Response tab — `GrERA`

- Status badge (200 OK) + content-type (application/json) + size (2.4 KB)
- Response body in dark code block with JSON syntax highlighting

### 7. Log Detail — Headers tab — `0z40s`

- **Request Headers**: key-value list (Accept, Accept-Encoding, Content-Type, User-Agent)
- **Response Headers**: key-value list (Content-Type, Cache-Control, X-Request-ID, X-Rate-Limit-Remaining)

### 8. Log Detail — Timing tab — `q549l`

- Total Duration progress bar: `142ms` (gradient bar: teal to purple)
- Breakdown list with colored dots:
  - DNS Lookup: 12ms
  - TCP Conn: 15ms
  - Time-to-First-Byte: 76ms (largest)
  - Content Transfer: 39ms

### 9. Log Detail — User Agent tab — `AaEey`

- Raw UA string displayed
- Parsed info grid (2x2):
  - Browser: Chrome 121.0
  - Device: Desktop
  - OS: macOS 14.2.1
  - Engine: WebKit / Blink

---

## Pages — Mobile (390px)

### 10. Mobile — Scanner Page — `uwSpN`

- **NavBar** (`lQYJQ`): Logo left, hamburger menu right, `height:56`
- **Content** (`LnY0G`): `padding:[24,16]`, `gap:24`
  - Same sections as desktop but stacked vertically
  - Stat cards: 2x2 grid instead of 4-column row
  - Issues table: simplified, single column cards with View links
  - Report section with stacked buttons: "Download PDF Report", "Export CSV", "Share Report"

### 11. Mobile — Reports Page — `0mTLB`

- NavBar with hamburger
- Summary cards stacked vertically (full width each)
- Stats shown as large numbers with labels
- "Recent Reports" list — card-style rows instead of table
  - Each row: website URL, date, status badge, score
  - Pagination at bottom

### 12. Mobile — Logs Page — `sjj8p`

- NavBar + search icon + filter icon
- Stat cards: 2x2 grid
- Filters: collapsible section, stacked inputs
- "Apply Filters" + "Reset" buttons full width
- Request logs: card-style list
  - Each card: method badge + endpoint, status + response time
  - Pagination

### 13. Mobile — Log Detail Modal — `8uEIu`

- **Bottom sheet** style (not centered modal): `cornerRadius:[16,16,0,0]` top
- Overlay bg at top (80px)
- Horizontal tabs instead of vertical sidebar: Overview, Request, Response, Headers, Timing
- All sections stacked vertically in scrollable area
- "Copy cURL" button + "Close" button at bottom

---

## Key Design Patterns

1. **Navigation**: Horizontal top bar, 56px height, logo left, links center, avatar right. Mobile: hamburger menu.
2. **Stat Cards**: Row of 4 cards with icon, large number, label, and trend/comparison. Mobile: 2x2 grid or stacked.
3. **Tables**: Full-width, bordered rows, sortable columns, colored status badges, pagination. Mobile: card-style lists.
4. **Modals**: Centered overlay (desktop) or bottom sheet (mobile), tabbed content with sidebar (desktop) or horizontal tabs (mobile).
5. **Color Coding**: Method badges (GET=green, POST=blue, PATCH=yellow, DELETE=red), status badges (2xx=green, 4xx=red, 5xx=red), severity (critical=red, warning=amber, pass=green).
6. **Footer**: Dark bg, 4-column link grid, social icons. Full width on mobile stacked.
7. **Spacing**: Desktop uses `padding:[*,120]` for horizontal margins. Mobile uses `padding:[*,16]`.
