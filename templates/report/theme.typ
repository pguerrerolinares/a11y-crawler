// Font
#let body-font = "Inter"

// Colors
#let primary = rgb("#2563eb")
#let critical-color = rgb("#dc2626")
#let serious-color = rgb("#ea580c")
#let moderate-color = rgb("#d97706")
#let minor-color = rgb("#2563eb")
#let pass-color = rgb("#16a34a")
#let fail-color = rgb("#dc2626")
#let gray-100 = rgb("#f3f4f6")
#let gray-500 = rgb("#6b7280")
#let gray-900 = rgb("#111827")

// Impact color helper
#let impact-color(impact) = {
  if impact == "critical" { critical-color }
  else if impact == "serious" { serious-color }
  else if impact == "moderate" { moderate-color }
  else { minor-color }
}

// Status badge
#let status-badge(status) = {
  let color = if status == "pass" { pass-color } else { fail-color }
  box(fill: color, radius: 3pt, inset: (x: 8pt, y: 3pt),
    text(fill: white, weight: "bold", size: 9pt, upper(status)))
}

// Section heading style
#let section-heading(title) = {
  v(12pt)
  text(fill: primary, size: 16pt, weight: "bold", title)
  v(4pt)
  line(length: 100%, stroke: 0.5pt + gray-100)
  v(8pt)
}
