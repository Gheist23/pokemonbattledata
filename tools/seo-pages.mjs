/**
 * Programmatic SEO pages built from the same battle data the explorer uses.
 *
 * generate-manifest.mjs owns the Pokémon profile pages and the hand-listed
 * topic pages. This module adds the entity and collection pages that the
 * dataset can support on its own -- one page per move, item and ability, a
 * per-Pokémon breakdown for moves/items/teammates, head-to-head comparisons,
 * team pages, per-format meta pages and ranking tables.
 *
 * Every page here is backed by real usage numbers rather than templated
 * filler: a move page lists the Pokémon that actually run the move and at
 * what percentage, an item page lists its real holders, and so on. Pages that
 * would have no data behind them are skipped rather than published empty.
 *
 * writeSeoPages() must run AFTER writePokemonPages(), because that function
 * wipes and recreates the whole pokemon/ directory and would otherwise delete
 * the per-Pokémon subpages written here. It returns every URL it produced so
 * writeSitemap() can include them.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const USAGE_CATEGORIES = { move: "move", held_item: "held_item", ability: "ability" };
const FORMATS = ["Doubles", "Singles"];

// Ruleset terms the ladder data is published under. Included in the keyword
// set of every generated page so the regulation queries resolve to the site.
export const REGULATION_KEYWORDS = [
  "Regulation M-A",
  "Regulation M-B",
  "Regulation M-C",
  "Pokemon Champions Regulation M-A",
  "Pokemon Champions Regulation M-B",
  "Pokemon Champions Regulation M-C",
  "Pokemon Champions regulations"
];

const REGULATION_NOTE =
  "Usage is collected from Pokemon Champions ranked ladder play across the current " +
  "regulations (Regulation M-A, Regulation M-B and Regulation M-C).";

// Team archetypes are derived from signal moves/abilities rather than being
// hand-maintained, so a shifting meta keeps the pages accurate by itself.
const TEAM_ARCHETYPES = [
  { slug: "rain", name: "Rain", moves: ["Rain Dance"], abilities: ["Drizzle", "Swift Swim"],
    blurb: "Rain teams turn on Drizzle or Rain Dance to power up Water moves and double Swift Swim Speed." },
  { slug: "sun", name: "Sun", moves: ["Sunny Day"], abilities: ["Drought", "Chlorophyll"],
    blurb: "Sun teams boost Fire damage and double Chlorophyll Speed while weakening opposing Water attacks." },
  { slug: "sand", name: "Sandstorm", moves: ["Sandstorm"], abilities: ["Sand Stream", "Sand Rush", "Sand Veil", "Sand Force"],
    blurb: "Sand teams chip non-Rock/Ground/Steel foes each turn and lean on Sand Rush Speed or Rock Special Defense." },
  { slug: "snow", name: "Snow", moves: ["Snowscape", "Hail", "Aurora Veil"], abilities: ["Snow Warning", "Slush Rush", "Ice Body"],
    blurb: "Snow teams raise Ice-type Defense and unlock Aurora Veil, the strongest dual screen in the format." },
  { slug: "trick-room", name: "Trick Room", moves: ["Trick Room"], abilities: [],
    blurb: "Trick Room inverts the Speed order for five turns so slow, heavy-hitting Pokemon move first." },
  { slug: "tailwind", name: "Tailwind", moves: ["Tailwind"], abilities: [],
    blurb: "Tailwind doubles your side's Speed for four turns, the most common way to outrun faster teams." },
  { slug: "terrain", name: "Terrain", moves: ["Electric Terrain", "Grassy Terrain", "Misty Terrain", "Psychic Terrain"],
    abilities: ["Electric Surge", "Grassy Surge", "Misty Surge", "Psychic Surge"],
    blurb: "Terrain teams change the battlefield to boost a type, block status, or shut down priority moves." },
  { slug: "redirection", name: "Redirection", moves: ["Follow Me", "Rage Powder"], abilities: ["Lightning Rod", "Storm Drain"],
    blurb: "Redirection support pulls attacks away from a fragile partner so it can set up or sweep safely." }
];

const RANKING_PAGES = [
  { slug: "most-used", title: "Most Used Pokemon in Pokemon Champions Doubles", format: "Doubles", kind: "usage",
    query: "pokemon champions most used pokemon" },
  { slug: "most-used-singles", title: "Most Used Pokemon in Pokemon Champions Singles", format: "Singles", kind: "usage",
    query: "pokemon champions most used pokemon singles" },
  { slug: "fastest", title: "Fastest Pokemon in Pokemon Champions", kind: "speed",
    query: "pokemon champions fastest pokemon speed tiers" },
  { slug: "highest-base-stats", title: "Highest Base Stat Totals in Pokemon Champions", kind: "bst",
    query: "pokemon champions highest base stats" },
  { slug: "most-used-items", title: "Most Used Held Items in Pokemon Champions", category: "held_item", kind: "category",
    query: "pokemon champions most used items" },
  { slug: "most-used-moves", title: "Most Used Moves in Pokemon Champions", category: "move", kind: "category",
    query: "pokemon champions most used moves" },
  { slug: "most-used-abilities", title: "Most Used Abilities in Pokemon Champions", category: "ability", kind: "category",
    query: "pokemon champions most used abilities" }
];

const VS_POKEMON_LIMIT = 30; // top N by Doubles rank -> N*(N-1)/2 comparison pages

export function writeSeoPages(ctx) {
  const {
    cwd, siteUrl, siteName, licenseUrl, assetRoot, generatedAt,
    pokemon, parseCSV, helpers
  } = ctx;
  const {
    escapeHtml, slugify, unique, numberOrZero, numberOrNull,
    percentNumber, rowName, categoryRows, summaryFor, battlePositionFor,
    metadataStatValue, basePageHtml, simpleTable, pokemonLink
  } = helpers;

  const urls = [];
  const reverseRedirects = [];
  const lastmod = generatedAt.slice(0, 10);

  /* ----------------------------------------------------------- indexes */

  // name -> { Doubles: [{record, percent, rank}], Singles: [...] }
  const usageIndex = new Map();
  for (const category of Object.keys(USAGE_CATEGORIES)) usageIndex.set(category, new Map());

  for (const record of pokemon) {
    for (const format of FORMATS) {
      const summary = summaryFor(record, format);
      for (const category of Object.keys(USAGE_CATEGORIES)) {
        for (const row of categoryRows(summary, category)) {
          const name = rowName(row);
          if (!name) continue;
          const byName = usageIndex.get(category);
          const entry = byName.get(name) || { name, Doubles: [], Singles: [] };
          entry[format].push({
            record,
            percent: percentNumber(row.percentage),
            rank: numberOrZero(row.rank),
            position: battlePositionFor(record, format)
          });
          byName.set(name, entry);
        }
      }
    }
  }
  for (const byName of usageIndex.values()) {
    for (const entry of byName.values()) {
      for (const format of FORMATS) entry[format].sort((a, b) => b.percent - a.percent);
    }
  }

  // Move facts come from the per-Pokémon legality tables, which carry clean
  // type/category/power columns; all_moves/ only holds the flavor text.
  const moveFacts = new Map();
  const moveLearners = new Map();
  const learnableDir = join(cwd, assetRoot, "learnable_moves");
  if (existsSync(learnableDir)) {
    for (const file of readdirSync(learnableDir).filter((name) => name.toLowerCase().endsWith(".csv"))) {
      const owner = basename(file, ".csv");
      for (const row of parseCSV(readFileSync(join(learnableDir, file), "utf8"))) {
        const name = String(row.move_name || row.move || row.name || "").trim();
        if (!name) continue;
        if (!moveFacts.has(name)) {
          moveFacts.set(name, {
            type: String(row.type || "").trim(),
            category: String(row.category || "").trim(),
            power: String(row.power || "").trim(),
            accuracy: String(row.accuracy || "").trim(),
            pp: String(row.pp || "").trim()
          });
        }
        const learners = moveLearners.get(name) || new Set();
        learners.add(owner);
        moveLearners.set(name, learners);
      }
    }
  }

  const moveDescriptions = new Map();
  const allMovesDir = join(cwd, assetRoot, "all_moves");
  if (existsSync(allMovesDir)) {
    for (const file of readdirSync(allMovesDir).filter((name) => name.toLowerCase().endsWith(".csv"))) {
      const name = basename(file, ".csv").replace(/_/g, " ");
      const texts = parseCSV(readFileSync(join(allMovesDir, file), "utf8"))
        .map((row) => String(row.text || row.description || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .filter((text) => text.toLowerCase() !== name.toLowerCase())
        .filter((text) => !/^(power|accuracy|pp)\b/i.test(text));
      if (texts.length) moveDescriptions.set(name, texts[texts.length - 1]);
    }
  }

  // Ability -> Pokémon that can have it, from species metadata.
  const abilityOwners = new Map();
  for (const record of pokemon) {
    const forms = record.summary?.forms || [];
    const names = new Set();
    for (const form of forms) {
      for (const field of [form.abilities, form.hidden_ability]) {
        for (const ability of String(field || "").split(/[|,/]/)) {
          const clean = ability.trim();
          if (clean) names.add(clean);
        }
      }
    }
    for (const ability of names) {
      const owners = abilityOwners.get(ability) || [];
      owners.push(record);
      abilityOwners.set(ability, owners);
    }
  }

  const recordBySlug = new Map(pokemon.map((record) => [record.slug, record]));

  /* ----------------------------------------------------------- helpers */

  const uniqueSlugs = new Map();
  function entitySlug(prefix, name) {
    const base = slugify(name) || "entry";
    const seen = uniqueSlugs.get(prefix) || new Map();
    if (seen.has(name)) return seen.get(name);
    let candidate = base;
    let suffix = 2;
    const taken = new Set(seen.values());
    while (taken.has(candidate)) candidate = `${base}-${suffix++}`;
    seen.set(name, candidate);
    uniqueSlugs.set(prefix, seen);
    return candidate;
  }

  /** `canonical` defaults to the page's own URL; pass a different one for an
   *  alternate spelling of the same page, which is then also kept out of the
   *  sitemap so only the canonical URL is submitted. */
  function writePage({ dir, url, canonical = url, sitemap = true, title, description, keywords, jsonLd, staticContent }) {
    const pageDir = join(cwd, ...dir);
    mkdirSync(pageDir, { recursive: true });
    writeFileSync(join(pageDir, "index.html"), basePageHtml({
      title,
      description,
      keywords: unique([...keywords, ...REGULATION_KEYWORDS]).join(", "),
      canonicalUrl: canonical,
      jsonLd,
      staticContent
    }));
    if (sitemap) urls.push(url);
  }

  function shell({ eyebrow, h1, lead, body, related = "" }) {
    return `<section class="section-shell static-seo-content" aria-label="${escapeHtml(h1)}">
    <div class="content-area static-seo-panel">
      <p class="eyebrow">${escapeHtml(eyebrow)}</p>
      <h1>${escapeHtml(h1)}</h1>
      <p>${escapeHtml(lead)}</p>
      ${body}
      <p class="static-seo-note">${escapeHtml(REGULATION_NOTE)}</p>
      ${related}
    </div>
  </section>`;
  }

  function linkList(heading, items) {
    if (!items.length) return "";
    return `<h2>${escapeHtml(heading)}</h2><ul class="static-link-list">${items
      .map((item) => `<li><a href="${escapeHtml(item.href)}">${escapeHtml(item.label)}</a></li>`)
      .join("")}</ul>`;
  }

  function collectionJsonLd({ url, title, description, keywords, items = [] }) {
    const graph = [
      {
        "@type": "CollectionPage",
        "@id": `${url}#webpage`,
        url,
        name: title,
        description,
        isPartOf: { "@id": `${siteUrl}/#website` },
        about: { "@id": `${siteUrl}/#dataset` }
      },
      {
        "@type": "Dataset",
        "@id": `${url}#dataset`,
        url,
        name: title,
        description,
        keywords: unique([...keywords, ...REGULATION_KEYWORDS]),
        creator: { "@type": "Organization", name: siteName, url: `${siteUrl}/` },
        license: licenseUrl,
        isAccessibleForFree: true,
        isPartOf: { "@id": `${siteUrl}/#dataset` }
      }
    ];
    if (items.length) {
      graph.push({
        "@type": "ItemList",
        "@id": `${url}#itemlist`,
        itemListElement: items.slice(0, 50).map((item, index) => ({
          "@type": "ListItem",
          position: index + 1,
          name: item.name,
          url: item.url
        }))
      });
    }
    return { "@context": "https://schema.org", "@graph": graph };
  }

  function breadcrumbJsonLd(trail) {
    return {
      "@type": "BreadcrumbList",
      itemListElement: trail.map((crumb, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: crumb.name,
        item: crumb.url
      }))
    };
  }

  function faqJsonLd(pairs) {
    return {
      "@type": "FAQPage",
      mainEntity: pairs.map(([question, answer]) => ({
        "@type": "Question",
        name: question,
        acceptedAnswer: { "@type": "Answer", text: answer }
      }))
    };
  }

  function usageTable(entries, limit = 25) {
    return simpleTable(["Pokemon", "Usage", "Slot", "Rank"], entries.slice(0, limit).map((entry) => (
      `<tr><td>${pokemonLink(entry.record)}</td><td>${escapeHtml(entry.percent ? `${entry.percent}%` : "-")}</td>` +
      `<td>${escapeHtml(entry.rank || "-")}</td><td>${escapeHtml(entry.position ?? "-")}</td></tr>`
    )));
  }

  function statRow(record, key) {
    return numberOrZero(metadataStatValue(record.summary?.primary || {}, key));
  }

  /* ------------------------------------------------------- entity pages */

  function writeEntityPages(category, dirName, singular, plural) {
    const byName = usageIndex.get(category);
    const written = [];
    for (const entry of byName.values()) {
      const doubles = entry.Doubles;
      const singles = entry.Singles;
      if (!doubles.length && !singles.length) continue;
      const slug = entitySlug(dirName, entry.name);
      const url = `${siteUrl}/${dirName}/${slug}/`;
      const facts = category === "move" ? moveFacts.get(entry.name) : null;
      const description = moveDescriptions.get(entry.name) || "";
      const learners = moveLearners.get(entry.name);
      const owners = category === "ability" ? (abilityOwners.get(entry.name) || []) : [];
      const users = unique([...doubles, ...singles].map((item) => item.record.name)).length;

      const factRows = [];
      if (facts) {
        if (facts.type) factRows.push(["Type", facts.type]);
        if (facts.category) factRows.push(["Category", facts.category]);
        if (facts.power) factRows.push(["Power", facts.power]);
        if (facts.accuracy) factRows.push(["Accuracy", facts.accuracy]);
        if (facts.pp) factRows.push(["PP", facts.pp]);
        if (learners) factRows.push(["Pokemon that can learn it", String(learners.size)]);
      }
      if (owners.length) factRows.push(["Pokemon with this ability", String(owners.length)]);
      factRows.push(["Pokemon using it in ranked play", String(users)]);
      if (doubles[0]) factRows.push(["Most common user (Doubles)", `${doubles[0].record.name} (${doubles[0].percent}%)`]);
      if (singles[0]) factRows.push(["Most common user (Singles)", `${singles[0].record.name} (${singles[0].percent}%)`]);

      const lead = category === "move"
        ? `${entry.name} usage in Pokemon Champions: which Pokemon run ${entry.name}, how often they carry it, and the move's type, power and accuracy.`
        : category === "held_item"
          ? `${entry.name} usage in Pokemon Champions: every Pokemon that commonly holds ${entry.name} in ranked Doubles and Singles, with usage percentages.`
          : `${entry.name} usage in Pokemon Champions: which Pokemon run ${entry.name} in ranked play and how often, plus every species that can have the ability.`;

      const body = [
        description ? `<p class="static-seo-lead">${escapeHtml(description)}</p>` : "",
        `<h2>${escapeHtml(entry.name)} at a glance</h2>`,
        simpleTable(["Field", "Value"], factRows.map(([label, value]) =>
          `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`)),
        doubles.length ? `<h2>Doubles usage</h2>${usageTable(doubles)}` : "",
        singles.length ? `<h2>Singles usage</h2>${usageTable(singles)}` : "",
        owners.length
          ? `<h2>Pokemon with ${escapeHtml(entry.name)}</h2><ul class="static-link-list">${owners
              .slice(0, 60).map((record) => `<li>${pokemonLink(record)}</li>`).join("")}</ul>`
          : ""
      ].join("");

      const related = linkList(`More Pokemon Champions ${plural}`, [
        { href: `/${dirName}/`, label: `All ${plural}` },
        { href: "/rankings/most-used/", label: "Most used Pokemon" },
        { href: "/meta/doubles/", label: "Doubles meta" },
        { href: "/meta/singles/", label: "Singles meta" }
      ]);

      const title = `${entry.name} - Pokemon Champions ${singular} Usage`;
      const jsonLd = collectionJsonLd({
        url, title, description: lead,
        keywords: [
          entry.name,
          `${entry.name} Pokemon Champions`,
          `${entry.name} pokemon champions ${category === "held_item" ? "item" : category}`,
          `${entry.name} usage`,
          `Pokemon Champions ${plural}`
        ]
      });
      jsonLd["@graph"].push(breadcrumbJsonLd([
        { name: "Home", url: `${siteUrl}/` },
        { name: plural.replace(/^\w/, (c) => c.toUpperCase()), url: `${siteUrl}/${dirName}/` },
        { name: entry.name, url }
      ]));
      jsonLd["@graph"].push(faqJsonLd([
        [`Which Pokemon use ${entry.name} in Pokemon Champions?`,
          doubles.length
            ? `${doubles.slice(0, 5).map((item) => `${item.record.name} (${item.percent}%)`).join(", ")} run ${entry.name} most often in ranked Doubles.`
            : `${singles.slice(0, 5).map((item) => `${item.record.name} (${item.percent}%)`).join(", ")} run ${entry.name} most often in ranked Singles.`],
        [`How many Pokemon run ${entry.name}?`,
          `${users} Pokemon carry ${entry.name} inside their tracked top options in Pokemon Champions ranked play.`]
      ]));

      writePage({
        dir: [dirName, slug], url, title, description: lead,
        keywords: [
          entry.name,
          `${entry.name} Pokemon Champions`,
          `${entry.name} pokemon champions`,
          `${entry.name} usage stats`,
          `${entry.name} best users`,
          `Pokemon Champions ${plural}`,
          `Pokemon Champions ${singular.toLowerCase()} usage`
        ],
        jsonLd,
        staticContent: shell({
          eyebrow: `Pokemon Champions ${singular}`,
          h1: `${entry.name} - Pokemon Champions ${singular} Usage`,
          lead, body, related
        })
      });
      written.push({ name: entry.name, slug, url, users, facts, entry });
    }

    written.sort((a, b) => b.users - a.users || a.name.localeCompare(b.name));

    // Hub page listing every entity of this kind.
    const hubUrl = `${siteUrl}/${dirName}/`;
    const hubTitle = `Pokemon Champions ${plural.replace(/^\w/, (c) => c.toUpperCase())} - Usage Index`;
    const hubLead = `Every ${singular.toLowerCase()} tracked in Pokemon Champions ranked battle data, ordered by how many Pokemon use it.`;
    const hubBody = simpleTable(
      category === "move" ? ["Move", "Type", "Category", "Power", "Pokemon using it"] : [singular, "Pokemon using it", "Top user"],
      written.map((item) => (category === "move"
        ? `<tr><td><a href="/${dirName}/${escapeHtml(item.slug)}/">${escapeHtml(item.name)}</a></td>` +
          `<td>${escapeHtml(item.facts?.type || "-")}</td><td>${escapeHtml(item.facts?.category || "-")}</td>` +
          `<td>${escapeHtml(item.facts?.power || "-")}</td><td>${escapeHtml(item.users)}</td></tr>`
        : `<tr><td><a href="/${dirName}/${escapeHtml(item.slug)}/">${escapeHtml(item.name)}</a></td>` +
          `<td>${escapeHtml(item.users)}</td>` +
          `<td>${escapeHtml(item.entry.Doubles[0]?.record.name || item.entry.Singles[0]?.record.name || "-")}</td></tr>`))
    );
    writePage({
      dir: [dirName], url: hubUrl, title: hubTitle, description: hubLead,
      keywords: [
        `Pokemon Champions ${plural}`,
        `pokemon champions ${plural}`,
        `Pokemon Champions ${singular.toLowerCase()} list`,
        `Pokemon Champions ${singular.toLowerCase()} usage`,
        "Pokemon Champions battle data"
      ],
      jsonLd: {
        ...collectionJsonLd({
          url: hubUrl, title: hubTitle, description: hubLead,
          keywords: [`Pokemon Champions ${plural}`],
          items: written.map((item) => ({ name: item.name, url: item.url }))
        })
      },
      staticContent: shell({
        eyebrow: `Pokemon Champions ${plural}`,
        h1: hubTitle,
        lead: hubLead,
        body: hubBody,
        related: linkList("Other Pokemon Champions indexes", [
          { href: "/pokemon/", label: "All Pokemon" },
          { href: "/moves/", label: "All moves" },
          { href: "/items/", label: "All held items" },
          { href: "/abilities/", label: "All abilities" },
          { href: "/rankings/", label: "Rankings" },
          { href: "/teams/", label: "Teams" }
        ])
      })
    });
    return written;
  }

  for (const dir of ["moves", "items", "abilities", "rankings", "teams"]) {
    const target = join(cwd, dir);
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }

  const movePages = writeEntityPages("move", "moves", "Move", "moves");
  const itemPages = writeEntityPages("held_item", "items", "Item", "held items");
  const abilityPages = writeEntityPages("ability", "abilities", "Ability", "abilities");

  /* --------------------------------------------- per-Pokémon subpages */

  const SUBPAGES = [
    { segment: "moves", category: "move", label: "Moves", noun: "moveset",
      lead: (name) => `Every move ${name} runs in Pokemon Champions ranked battles, with usage percentages for Doubles and Singles.` },
    { segment: "items", category: "held_item", label: "Held Items", noun: "items",
      lead: (name) => `Which held items ${name} runs in Pokemon Champions, ranked by how often each item appears.` },
    { segment: "teammates", category: "teammate", label: "Teammates", noun: "teammates",
      lead: (name) => `The Pokemon most often paired with ${name} in Pokemon Champions ranked teams.` }
  ];

  for (const record of pokemon) {
    for (const sub of SUBPAGES) {
      const tables = [];
      let hasRows = false;
      for (const format of FORMATS) {
        const rows = categoryRows(summaryFor(record, format), sub.category);
        if (!rows.length) continue;
        hasRows = true;
        tables.push(`<h2>${escapeHtml(format)}</h2>` + simpleTable(
          sub.category === "teammate" ? ["#", "Teammate"] : ["#", sub.label.replace(/s$/, ""), "Usage"],
          rows.map((row) => {
            const name = rowName(row);
            if (sub.category === "teammate") {
              const partner = pokemon.find((candidate) => candidate.name === name);
              return `<tr><td>${escapeHtml(row.rank ?? "-")}</td><td>${partner ? pokemonLink(partner) : escapeHtml(name)}</td></tr>`;
            }
            const dirName = sub.category === "move" ? "moves" : "items";
            const slugMap = uniqueSlugs.get(dirName);
            const entrySlug = slugMap?.get(name);
            const label = entrySlug ? `<a href="/${dirName}/${escapeHtml(entrySlug)}/">${escapeHtml(name)}</a>` : escapeHtml(name);
            return `<tr><td>${escapeHtml(row.rank ?? "-")}</td><td>${label}</td><td>${escapeHtml(row.percentage || "-")}</td></tr>`;
          })
        ));
      }
      if (!hasRows) continue;

      const url = `${siteUrl}/pokemon/${record.slug}/${sub.segment}/`;
      const title = `${record.name} ${sub.label} - Pokemon Champions`;
      const lead = sub.lead(record.name);
      const jsonLd = collectionJsonLd({
        url, title, description: lead,
        keywords: [`${record.name} ${sub.noun}`, `${record.name} pokemon champions ${sub.segment}`]
      });
      jsonLd["@graph"].push(breadcrumbJsonLd([
        { name: "Home", url: `${siteUrl}/` },
        { name: "Pokemon", url: `${siteUrl}/pokemon/` },
        { name: record.name, url: `${siteUrl}/pokemon/${record.slug}/` },
        { name: sub.label, url }
      ]));

      writePage({
        dir: ["pokemon", record.slug, sub.segment], url, title, description: lead,
        keywords: [
          `${record.name} ${sub.noun}`,
          `${record.name} pokemon champions ${sub.segment}`,
          `${record.name} pokemon champions`,
          `${record.name} best ${sub.noun}`,
          `${record.name} usage stats`,
          "Pokemon Champions battle data"
        ],
        jsonLd,
        staticContent: shell({
          eyebrow: `${record.name} ${sub.label}`,
          h1: title,
          lead,
          body: tables.join(""),
          related: linkList(`More ${record.name} data`, [
            { href: `/pokemon/${record.slug}/`, label: `${record.name} profile` },
            ...SUBPAGES.filter((other) => other.segment !== sub.segment)
              .map((other) => ({ href: `/pokemon/${record.slug}/${other.segment}/`, label: `${record.name} ${other.label.toLowerCase()}` })),
            { href: `/teams/${record.slug}/`, label: `${record.name} teams` }
          ])
        })
      });
    }
  }

  /* ------------------------------------------------ comparison pages */

  const vsPool = pokemon
    .map((record) => ({ record, position: battlePositionFor(record, "Doubles") }))
    .filter((entry) => Number.isFinite(entry.position))
    .sort((a, b) => a.position - b.position)
    .slice(0, VS_POKEMON_LIMIT)
    .map((entry) => entry.record);

  const STAT_FIELDS = [["hp", "HP"], ["attack", "Attack"], ["defense", "Defense"],
    ["sp_attack", "Sp. Attack"], ["sp_defense", "Sp. Defense"], ["speed", "Speed"], ["base_stat_total", "Total"]];

  for (let i = 0; i < vsPool.length; i += 1) {
    for (let j = i + 1; j < vsPool.length; j += 1) {
      // Order the pair alphabetically so the canonical URL is predictable
      // ("garchomp-vs-kingambit", not whichever happens to rank higher). The
      // reverse spelling is published too, pointing its canonical here, so
      // both "a vs b" and "b vs a" searches land on one indexed page.
      const [a, b] = [vsPool[i], vsPool[j]].sort((x, y) => x.slug.localeCompare(y.slug));
      const slug = `${a.slug}-vs-${b.slug}`;
      const reverseSlug = `${b.slug}-vs-${a.slug}`;
      const url = `${siteUrl}/pokemon/${slug}/`;
      const title = `${a.name} vs ${b.name} - Pokemon Champions Comparison`;
      const aSpeed = statRow(a, "speed");
      const bSpeed = statRow(b, "speed");
      const faster = aSpeed === bSpeed ? "They tie on base Speed" : `${aSpeed > bSpeed ? a.name : b.name} is faster`;
      const aRank = battlePositionFor(a, "Doubles");
      const bRank = battlePositionFor(b, "Doubles");
      const lead = `${a.name} and ${b.name} compared in Pokemon Champions: base stats, types, ranked usage, and the moves, items and abilities each one runs.`;

      const statTable = simpleTable(["Stat", a.name, b.name], STAT_FIELDS.map(([key, label]) => {
        const av = statRow(a, key);
        const bv = statRow(b, key);
        const mark = (value, other) => value > other ? `<strong>${escapeHtml(value || "-")}</strong>` : escapeHtml(value || "-");
        return `<tr><td>${escapeHtml(label)}</td><td>${mark(av, bv)}</td><td>${mark(bv, av)}</td></tr>`;
      }));

      const metaTable = simpleTable(["Field", a.name, b.name], [
        ["Types", (a.summary?.types || []).join(" / ") || "-", (b.summary?.types || []).join(" / ") || "-"],
        ["Doubles rank", aRank ?? "-", bRank ?? "-"],
        ["Singles rank", battlePositionFor(a, "Singles") ?? "-", battlePositionFor(b, "Singles") ?? "-"],
        ["Top move", rowName(summaryFor(a, "Doubles").top?.move) || "-", rowName(summaryFor(b, "Doubles").top?.move) || "-"],
        ["Top item", rowName(summaryFor(a, "Doubles").top?.held_item) || "-", rowName(summaryFor(b, "Doubles").top?.held_item) || "-"],
        ["Top ability", rowName(summaryFor(a, "Doubles").top?.ability) || "-", rowName(summaryFor(b, "Doubles").top?.ability) || "-"]
      ].map(([label, av, bv]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(av)}</td><td>${escapeHtml(bv)}</td></tr>`));

      const verdict = `${faster} (${aSpeed} vs ${bSpeed} base Speed). ` +
        (Number.isFinite(aRank) && Number.isFinite(bRank)
          ? `${aRank < bRank ? a.name : b.name} is the more used of the two in ranked Doubles (rank ${Math.min(aRank, bRank)} vs ${Math.max(aRank, bRank)}).`
          : "");

      const jsonLd = collectionJsonLd({
        url, title, description: lead,
        keywords: [`${a.name} vs ${b.name}`, `${a.name} vs ${b.name} pokemon champions`]
      });
      jsonLd["@graph"].push(breadcrumbJsonLd([
        { name: "Home", url: `${siteUrl}/` },
        { name: "Pokemon", url: `${siteUrl}/pokemon/` },
        { name: `${a.name} vs ${b.name}`, url }
      ]));
      jsonLd["@graph"].push(faqJsonLd([
        [`Is ${a.name} or ${b.name} faster in Pokemon Champions?`, verdict],
        [`Which is used more, ${a.name} or ${b.name}?`,
          Number.isFinite(aRank) && Number.isFinite(bRank)
            ? `${aRank < bRank ? a.name : b.name} ranks higher in Pokemon Champions ranked Doubles usage (rank ${Math.min(aRank, bRank)} against rank ${Math.max(aRank, bRank)}).`
            : `Ranked usage data is only available for one of the two.`]
      ]));

      const vsPage = {
        url, title, description: lead,
        keywords: [
          `${a.name} vs ${b.name}`,
          `${a.name} vs ${b.name} pokemon champions`,
          `${b.name} vs ${a.name}`,
          `${b.name} vs ${a.name} pokemon champions`,
          `${a.name} pokemon champions`,
          `${b.name} pokemon champions`,
          "Pokemon Champions comparison"
        ],
        jsonLd,
        staticContent: shell({
          eyebrow: "Pokemon Champions comparison",
          h1: title,
          lead,
          body: `<h2>Base stats</h2>${statTable}<h2>Ranked profile</h2>${metaTable}<h2>Verdict</h2><p>${escapeHtml(verdict)}</p>`,
          related: linkList("Full profiles", [
            { href: `/pokemon/${a.slug}/`, label: `${a.name} profile` },
            { href: `/pokemon/${b.slug}/`, label: `${b.name} profile` },
            { href: `/pokemon/${a.slug}/moves/`, label: `${a.name} moves` },
            { href: `/pokemon/${b.slug}/moves/`, label: `${b.name} moves` },
            { href: "/rankings/most-used/", label: "Most used Pokemon" }
          ])
        })
      };
      writePage({ dir: ["pokemon", slug], ...vsPage });
      // The reverse spelling is served as a 301 rather than a second HTML file:
      // it consolidates ranking signals onto one URL instead of relying on a
      // canonical tag, and keeps 435 files out of the deployment (Cloudflare
      // Pages caps a deployment at 20,000 files).
      reverseRedirects.push([`/pokemon/${reverseSlug}/`, `/pokemon/${slug}/`]);
    }
  }

  /* ------------------------------------------------------ team pages */

  const teamPages = [];
  for (const record of pokemon) {
    const rows = categoryRows(summaryFor(record, "Doubles"), "teammate");
    const singlesRows = categoryRows(summaryFor(record, "Singles"), "teammate");
    if (!rows.length && !singlesRows.length) continue;
    const url = `${siteUrl}/teams/${record.slug}/`;
    const title = `${record.name} Teams - Pokemon Champions Teammates`;
    const lead = `Build around ${record.name} in Pokemon Champions: its most common teammates, the cores it appears in, and the items and moves that support it.`;
    const partnersTable = (list, format) => list.length
      ? `<h2>${escapeHtml(format)} teammates</h2>` + simpleTable(["#", "Teammate", "Doubles rank"], list.map((row) => {
          const name = rowName(row);
          const partner = pokemon.find((candidate) => candidate.name === name);
          return `<tr><td>${escapeHtml(row.rank ?? "-")}</td><td>${partner ? pokemonLink(partner) : escapeHtml(name)}</td>` +
            `<td>${escapeHtml(partner ? (battlePositionFor(partner, "Doubles") ?? "-") : "-")}</td></tr>`;
        }))
      : "";

    const jsonLd = collectionJsonLd({ url, title, description: lead, keywords: [`${record.name} team`, `${record.name} teammates`] });
    jsonLd["@graph"].push(breadcrumbJsonLd([
      { name: "Home", url: `${siteUrl}/` },
      { name: "Teams", url: `${siteUrl}/teams/` },
      { name: record.name, url }
    ]));

    writePage({
      dir: ["teams", record.slug], url, title, description: lead,
      keywords: [
        `${record.name} team`,
        `${record.name} teammates`,
        `${record.name} pokemon champions teammates`,
        `${record.name} pokemon champions team`,
        `best ${record.name} team`,
        "Pokemon Champions team builder"
      ],
      jsonLd,
      staticContent: shell({
        eyebrow: "Pokemon Champions teams",
        h1: title,
        lead,
        body: partnersTable(rows, "Doubles") + partnersTable(singlesRows, "Singles"),
        related: linkList(`More ${record.name} data`, [
          { href: `/pokemon/${record.slug}/`, label: `${record.name} profile` },
          { href: `/pokemon/${record.slug}/moves/`, label: `${record.name} moves` },
          { href: `/pokemon/${record.slug}/items/`, label: `${record.name} items` },
          { href: "/teams/", label: "All team pages" }
        ])
      })
    });
    teamPages.push({ name: record.name, slug: record.slug, url });
  }

  for (const archetype of TEAM_ARCHETYPES) {
    const moveSet = new Set(archetype.moves);
    const abilitySet = new Set(archetype.abilities);
    const members = pokemon
      .map((record) => {
        const summary = summaryFor(record, "Doubles");
        const moves = categoryRows(summary, "move").filter((row) => moveSet.has(rowName(row)));
        const abilities = categoryRows(summary, "ability").filter((row) => abilitySet.has(rowName(row)));
        const score = Math.max(
          ...moves.map((row) => percentNumber(row.percentage)),
          ...abilities.map((row) => percentNumber(row.percentage)),
          0
        );
        return { record, moves, abilities, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || (battlePositionFor(a.record, "Doubles") ?? 999) - (battlePositionFor(b.record, "Doubles") ?? 999));

    if (!members.length) continue;
    const url = `${siteUrl}/teams/${archetype.slug}/`;
    const title = `Pokemon Champions ${archetype.name} Teams`;
    const lead = `${archetype.blurb} These are the Pokemon that actually run ${archetype.name.toLowerCase()} tools in Pokemon Champions ranked Doubles, ordered by how often they carry them.`;
    const table = simpleTable(["Pokemon", "Doubles rank", "Signal", "Usage"], members.slice(0, 40).map((entry) => {
      const signal = [...entry.moves, ...entry.abilities][0];
      return `<tr><td>${pokemonLink(entry.record)}</td><td>${escapeHtml(battlePositionFor(entry.record, "Doubles") ?? "-")}</td>` +
        `<td>${escapeHtml(rowName(signal) || "-")}</td><td>${escapeHtml(signal?.percentage || "-")}</td></tr>`;
    }));

    const jsonLd = collectionJsonLd({
      url, title, description: lead,
      keywords: [`Pokemon Champions ${archetype.name}`, `${archetype.name} team pokemon champions`],
      items: members.slice(0, 30).map((entry) => ({ name: entry.record.name, url: `${siteUrl}/pokemon/${entry.record.slug}/` }))
    });
    jsonLd["@graph"].push(breadcrumbJsonLd([
      { name: "Home", url: `${siteUrl}/` },
      { name: "Teams", url: `${siteUrl}/teams/` },
      { name: archetype.name, url }
    ]));

    writePage({
      dir: ["teams", archetype.slug], url, title, description: lead,
      keywords: [
        `Pokemon Champions ${archetype.name} team`,
        `${archetype.name.toLowerCase()} team pokemon champions`,
        `pokemon champions ${archetype.slug}`,
        `best ${archetype.name.toLowerCase()} pokemon champions`,
        "Pokemon Champions team builder"
      ],
      jsonLd,
      staticContent: shell({
        eyebrow: "Pokemon Champions archetype",
        h1: title,
        lead,
        body: table,
        related: linkList("Other archetypes", TEAM_ARCHETYPES
          .filter((other) => other.slug !== archetype.slug)
          .map((other) => ({ href: `/teams/${other.slug}/`, label: `${other.name} teams` })))
      })
    });
    teamPages.push({ name: `${archetype.name} teams`, slug: archetype.slug, url });
  }

  // Teams hub
  {
    const url = `${siteUrl}/teams/`;
    const title = "Pokemon Champions Teams and Teammates";
    const lead = "Team building data for Pokemon Champions: the most common partners for every ranked Pokemon plus the weather, Trick Room, Tailwind and terrain archetypes the ladder actually runs.";
    writePage({
      dir: ["teams"], url, title, description: lead,
      keywords: ["Pokemon Champions teams", "pokemon champions team builder", "Pokemon Champions teammates", "Pokemon Champions cores"],
      jsonLd: collectionJsonLd({ url, title, description: lead, keywords: ["Pokemon Champions teams"], items: teamPages }),
      staticContent: shell({
        eyebrow: "Pokemon Champions teams",
        h1: title,
        lead,
        body: linkList("Archetypes", TEAM_ARCHETYPES.map((archetype) => ({ href: `/teams/${archetype.slug}/`, label: `${archetype.name} teams` }))) +
          linkList("Teams by Pokemon", teamPages.filter((page) => !TEAM_ARCHETYPES.some((a) => a.slug === page.slug))
            .map((page) => ({ href: `/teams/${page.slug}/`, label: page.name })))
      })
    });
  }

  /* --------------------------------------------------- meta by format */

  for (const format of FORMATS) {
    const slug = format.toLowerCase();
    const url = `${siteUrl}/meta/${slug}/`;
    const ranked = pokemon
      .map((record) => ({ record, position: battlePositionFor(record, format) }))
      .filter((entry) => Number.isFinite(entry.position))
      .sort((a, b) => a.position - b.position)
      .slice(0, 60);
    if (!ranked.length) continue;
    const title = `Pokemon Champions ${format} Meta - Usage Stats and Tier List`;
    const lead = `The Pokemon Champions ${format} meta by ranked usage: the most used Pokemon, their top moves, held items and abilities, updated from daily ladder snapshots.`;
    const table = simpleTable(["Rank", "Pokemon", "Types", "Top move", "Top item", "Top ability"], ranked.map(({ record, position }) => {
      const summary = summaryFor(record, format);
      return `<tr><td>${escapeHtml(position)}</td><td>${pokemonLink(record)}</td>` +
        `<td>${escapeHtml((record.summary?.types || []).join(" / ") || "-")}</td>` +
        `<td>${escapeHtml(rowName(summary.top?.move) || "-")}</td>` +
        `<td>${escapeHtml(rowName(summary.top?.held_item) || "-")}</td>` +
        `<td>${escapeHtml(rowName(summary.top?.ability) || "-")}</td></tr>`;
    }));

    const topEntities = (category, limit = 15) => {
      const counts = new Map();
      for (const { record } of ranked) {
        for (const row of categoryRows(summaryFor(record, format), category).slice(0, 4)) {
          const name = rowName(row);
          if (!name) continue;
          counts.set(name, (counts.get(name) || 0) + 1);
        }
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
    };

    const entitySection = (category, dirName, heading) => simpleTable([heading, "Top-60 Pokemon running it"],
      topEntities(category).map(([name, count]) => {
        const entrySlug = uniqueSlugs.get(dirName)?.get(name);
        const label = entrySlug ? `<a href="/${dirName}/${escapeHtml(entrySlug)}/">${escapeHtml(name)}</a>` : escapeHtml(name);
        return `<tr><td>${label}</td><td>${escapeHtml(count)}</td></tr>`;
      }));

    const jsonLd = collectionJsonLd({
      url, title, description: lead,
      keywords: [`Pokemon Champions ${format} meta`, `pokemon champions ${slug} meta`, "Pokemon Champions tier list"],
      items: ranked.map(({ record }) => ({ name: record.name, url: `${siteUrl}/pokemon/${record.slug}/` }))
    });
    jsonLd["@graph"].push(breadcrumbJsonLd([
      { name: "Home", url: `${siteUrl}/` },
      { name: "Meta", url: `${siteUrl}/meta/` },
      { name: format, url }
    ]));
    jsonLd["@graph"].push(faqJsonLd([
      [`What is the best Pokemon in Pokemon Champions ${format}?`,
        `${ranked[0].record.name} is the most used Pokemon in Pokemon Champions ranked ${format}, followed by ${ranked.slice(1, 4).map((entry) => entry.record.name).join(", ")}.`],
      [`How often is the Pokemon Champions ${format} meta updated?`,
        "Usage is rebuilt from a new ranked ladder snapshot every day, so the tables reflect the current regulation."]
    ]));

    writePage({
      dir: ["meta", slug], url, title, description: lead,
      keywords: [
        `Pokemon Champions ${format} meta`,
        `pokemon champions ${slug} meta`,
        `pokemon champions ${slug} usage stats`,
        "Pokemon Champions tier list",
        "Pokemon Champions usage stats",
        "Pokemon Champions most used pokemon",
        "Pokemon Champions M5"
      ],
      jsonLd,
      staticContent: shell({
        eyebrow: `Pokemon Champions ${format}`,
        h1: title,
        lead,
        body: `<h2>Most used ${format} Pokemon</h2>${table}` +
          `<h2>Most common moves</h2>${entitySection("move", "moves", "Move")}` +
          `<h2>Most common held items</h2>${entitySection("held_item", "items", "Item")}` +
          `<h2>Most common abilities</h2>${entitySection("ability", "abilities", "Ability")}`,
        related: linkList("More Pokemon Champions meta", [
          { href: "/meta/", label: "Meta trends (daily risers and fallers)" },
          { href: `/meta/${format === "Doubles" ? "singles" : "doubles"}/`, label: `${format === "Doubles" ? "Singles" : "Doubles"} meta` },
          { href: "/rankings/most-used/", label: "Most used Pokemon" },
          { href: "/rankings/most-used-items/", label: "Most used items" }
        ])
      })
    });
  }

  /* -------------------------------------------------- ranking pages */

  const rankingLinks = RANKING_PAGES.map((page) => ({ href: `/rankings/${page.slug}/`, label: page.title }));

  for (const page of RANKING_PAGES) {
    const url = `${siteUrl}/rankings/${page.slug}/`;
    let body = "";
    let lead = "";
    let items = [];

    if (page.kind === "usage") {
      const ranked = pokemon
        .map((record) => ({ record, position: battlePositionFor(record, page.format) }))
        .filter((entry) => Number.isFinite(entry.position))
        .sort((a, b) => a.position - b.position)
        .slice(0, 100);
      lead = `The 100 most used Pokemon in Pokemon Champions ranked ${page.format}, ordered by ladder usage with their most common move, item and ability.`;
      body = simpleTable(["Rank", "Pokemon", "Types", "Top move", "Top item", "Top ability"], ranked.map(({ record, position }) => {
        const summary = summaryFor(record, page.format);
        return `<tr><td>${escapeHtml(position)}</td><td>${pokemonLink(record)}</td>` +
          `<td>${escapeHtml((record.summary?.types || []).join(" / ") || "-")}</td>` +
          `<td>${escapeHtml(rowName(summary.top?.move) || "-")}</td>` +
          `<td>${escapeHtml(rowName(summary.top?.held_item) || "-")}</td>` +
          `<td>${escapeHtml(rowName(summary.top?.ability) || "-")}</td></tr>`;
      }));
      items = ranked.map(({ record }) => ({ name: record.name, url: `${siteUrl}/pokemon/${record.slug}/` }));
    } else if (page.kind === "speed") {
      const fastest = [...pokemon]
        .map((record) => ({ record, speed: statRow(record, "speed") }))
        .filter((entry) => entry.speed > 0)
        .sort((a, b) => b.speed - a.speed)
        .slice(0, 100);
      lead = "Pokemon Champions speed tiers: the fastest Pokemon by base Speed, with their ranked usage in Doubles and Singles.";
      body = simpleTable(["Base Speed", "Pokemon", "Types", "Doubles rank", "Singles rank"], fastest.map(({ record, speed }) =>
        `<tr><td>${escapeHtml(speed)}</td><td>${pokemonLink(record)}</td>` +
        `<td>${escapeHtml((record.summary?.types || []).join(" / ") || "-")}</td>` +
        `<td>${escapeHtml(battlePositionFor(record, "Doubles") ?? "-")}</td>` +
        `<td>${escapeHtml(battlePositionFor(record, "Singles") ?? "-")}</td></tr>`));
      items = fastest.map(({ record }) => ({ name: record.name, url: `${siteUrl}/pokemon/${record.slug}/` }));
    } else if (page.kind === "bst") {
      const strongest = [...pokemon]
        .map((record) => ({ record, total: statRow(record, "base_stat_total") }))
        .filter((entry) => entry.total > 0)
        .sort((a, b) => b.total - a.total)
        .slice(0, 100);
      lead = "Pokemon Champions base stat totals: the highest raw stat pools in the game, next to how much ranked play actually uses them.";
      body = simpleTable(["Total", "Pokemon", "HP", "Atk", "Def", "SpA", "SpD", "Spe", "Doubles rank"], strongest.map(({ record, total }) =>
        `<tr><td>${escapeHtml(total)}</td><td>${pokemonLink(record)}</td>` +
        ["hp", "attack", "defense", "sp_attack", "sp_defense", "speed"].map((key) => `<td>${escapeHtml(statRow(record, key) || "-")}</td>`).join("") +
        `<td>${escapeHtml(battlePositionFor(record, "Doubles") ?? "-")}</td></tr>`));
      items = strongest.map(({ record }) => ({ name: record.name, url: `${siteUrl}/pokemon/${record.slug}/` }));
    } else {
      const dirName = page.category === "move" ? "moves" : page.category === "held_item" ? "items" : "abilities";
      const source = page.category === "move" ? movePages : page.category === "held_item" ? itemPages : abilityPages;
      lead = `The most used ${dirName} in Pokemon Champions ranked play, counted by how many different Pokemon carry each one.`;
      body = simpleTable(["Rank", dirName.replace(/s$/, "").replace(/^\w/, (c) => c.toUpperCase()), "Pokemon using it", "Top user"],
        source.slice(0, 100).map((entry, index) =>
          `<tr><td>${index + 1}</td><td><a href="/${dirName}/${escapeHtml(entry.slug)}/">${escapeHtml(entry.name)}</a></td>` +
          `<td>${escapeHtml(entry.users)}</td>` +
          `<td>${escapeHtml(entry.entry.Doubles[0]?.record.name || entry.entry.Singles[0]?.record.name || "-")}</td></tr>`));
      items = source.slice(0, 50).map((entry) => ({ name: entry.name, url: entry.url }));
    }

    const jsonLd = collectionJsonLd({ url, title: page.title, description: lead, keywords: [page.query], items });
    jsonLd["@graph"].push(breadcrumbJsonLd([
      { name: "Home", url: `${siteUrl}/` },
      { name: "Rankings", url: `${siteUrl}/rankings/` },
      { name: page.title, url }
    ]));

    writePage({
      dir: ["rankings", page.slug], url, title: page.title, description: lead,
      keywords: [page.query, page.title, "Pokemon Champions usage stats", "Pokemon Champions rankings", "Pokemon Champions tier list"],
      jsonLd,
      staticContent: shell({
        eyebrow: "Pokemon Champions rankings",
        h1: page.title,
        lead,
        body,
        related: linkList("Other rankings", rankingLinks.filter((link) => link.href !== `/rankings/${page.slug}/`))
      })
    });
  }

  {
    const url = `${siteUrl}/rankings/`;
    const title = "Pokemon Champions Rankings - Usage, Speed and Stats";
    const lead = "Every Pokemon Champions ranking built from ladder data: most used Pokemon in Doubles and Singles, speed tiers, base stat totals, and the most used moves, items and abilities.";
    writePage({
      dir: ["rankings"], url, title, description: lead,
      keywords: ["Pokemon Champions rankings", "pokemon champions usage stats", "Pokemon Champions tier list", "Pokemon Champions most used pokemon"],
      jsonLd: collectionJsonLd({
        url, title, description: lead, keywords: ["Pokemon Champions rankings"],
        items: RANKING_PAGES.map((page) => ({ name: page.title, url: `${siteUrl}/rankings/${page.slug}/` }))
      }),
      staticContent: shell({
        eyebrow: "Pokemon Champions rankings",
        h1: title,
        lead,
        body: linkList("All rankings", rankingLinks),
        related: linkList("Meta pages", [
          { href: "/meta/doubles/", label: "Doubles meta" },
          { href: "/meta/singles/", label: "Singles meta" },
          { href: "/meta/", label: "Daily meta trends" }
        ])
      })
    });
  }

  /* -------------------------------------------------- Pokemon index */

  {
    const url = `${siteUrl}/pokemon/`;
    const title = "All Pokemon in Pokemon Champions - Usage Index";
    const lead = "Every Pokemon tracked in Pokemon Champions ranked battle data, with Doubles and Singles usage ranks and links to full movesets, items and teammates.";
    const ordered = [...pokemon].sort((a, b) => {
      const ap = battlePositionFor(a, "Doubles") ?? 9999;
      const bp = battlePositionFor(b, "Doubles") ?? 9999;
      return ap - bp || a.name.localeCompare(b.name);
    });
    const table = simpleTable(["Doubles rank", "Pokemon", "Types", "Singles rank", "Data"], ordered.map((record) =>
      `<tr><td>${escapeHtml(battlePositionFor(record, "Doubles") ?? "-")}</td><td>${pokemonLink(record)}</td>` +
      `<td>${escapeHtml((record.summary?.types || []).join(" / ") || "-")}</td>` +
      `<td>${escapeHtml(battlePositionFor(record, "Singles") ?? "-")}</td>` +
      `<td><a href="/pokemon/${escapeHtml(record.slug)}/moves/">moves</a> · ` +
      `<a href="/pokemon/${escapeHtml(record.slug)}/items/">items</a> · ` +
      `<a href="/pokemon/${escapeHtml(record.slug)}/teammates/">teammates</a></td></tr>`));
    writePage({
      dir: ["pokemon"], url, title, description: lead,
      keywords: ["Pokemon Champions pokemon list", "all pokemon champions pokemon", "Pokemon Champions usage stats", "Pokemon Champions pokedex"],
      jsonLd: collectionJsonLd({
        url, title, description: lead, keywords: ["Pokemon Champions pokemon list"],
        items: ordered.map((record) => ({ name: record.name, url: `${siteUrl}/pokemon/${record.slug}/` }))
      }),
      staticContent: shell({
        eyebrow: "Pokemon Champions index",
        h1: title,
        lead,
        body: table,
        related: linkList("Indexes", [
          { href: "/moves/", label: "All moves" },
          { href: "/items/", label: "All held items" },
          { href: "/abilities/", label: "All abilities" },
          { href: "/teams/", label: "Teams" },
          { href: "/rankings/", label: "Rankings" }
        ])
      })
    });
  }

  /* -------------------------------------------------- reverse redirects */

  // _redirects keeps its hand-written entries; everything below the marker is
  // regenerated each build so stale comparison redirects cannot pile up.
  {
    const marker = "# --- generated: reverse comparison URLs (do not edit below) ---";
    const redirectsPath = join(cwd, "_redirects");
    const existing = existsSync(redirectsPath) ? readFileSync(redirectsPath, "utf8") : "";
    const manual = existing.split(marker)[0].replace(/\s+$/, "");
    const generated = reverseRedirects
      .map(([from, to]) => `${from} ${to} 301`)
      .sort()
      .join("\n");
    writeFileSync(redirectsPath, `${manual}\n\n${marker}\n${generated}\n`);
  }

  return {
    urls,
    lastmod,
    counts: {
      moves: movePages.length,
      items: itemPages.length,
      abilities: abilityPages.length,
      redirects: reverseRedirects.length,
      total: urls.length
    }
  };
}
