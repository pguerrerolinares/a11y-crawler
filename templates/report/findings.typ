#import "theme.typ": *

#let data = json(sys.inputs.datafile)

#section-heading("Findings")

#for category in data.categories {
  v(16pt)
  text(size: 13pt, weight: "bold", fill: primary)[#category.name]
  v(4pt)
  text(size: 10pt, fill: gray-500)[#category.description]
  v(8pt)

  for finding in category.findings {
    block(
      stroke: 0.5pt + gray-100,
      radius: 4pt,
      inset: 12pt,
      width: 100%,
      breakable: false,
    )[
      #grid(
        columns: (1fr, auto, auto),
        gutter: 8pt,
        [*WCAG #finding.criterion* — #finding.controlName],
        [#text(size: 9pt, fill: gray-500)[#finding.level]],
        [#status-badge("fail")]
      )
      #v(6pt)
      #if finding.requirement != "" {
        text(size: 9pt, fill: gray-500)[*Requirement:* #finding.requirement]
        v(4pt)
      }
      #text(size: 10pt)[#finding.finding]
      #v(4pt)
      #text(size: 9pt, fill: gray-500)[
        Affects #str(finding.issueCount) instance(s) across #str(finding.affectedPages.len()) page(s)
      ]
      #v(4pt)
      #block(fill: gray-100, radius: 3pt, inset: 8pt, width: 100%)[
        #text(size: 9pt)[*Remediation:* #finding.remediation]
      ]
      #if "instances" in finding and finding.instances != none and finding.instances.len() > 0 {
        v(8pt)
        text(size: 9pt, weight: "bold")[Instances:]
        v(4pt)
        table(
          columns: (2fr, 3fr),
          fill: (_, y) => if calc.odd(y) { gray-100 } else { white },
          table.header([*Page*], [*Selector*]),
          ..finding.instances.map(inst => (
            text(size: 8pt)[#inst.url],
            raw(inst.selector),
          )).flatten()
        )
      }
    ]
    v(8pt)
  }
}
