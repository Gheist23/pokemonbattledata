// The slash commands, in the shape Discord registers them.
//
// One definition list, used twice: tools/register-discord-commands.mjs PUTs it
// to Discord, and functions/api/discord/interactions.js routes against it, so a
// command cannot exist in one place and not the other.
//
// Every command that names a Pokemon takes it as an autocompleting string, so a
// Discord user picks a real battle-data name instead of guessing a spelling.
// `format` is optional everywhere and defaults to Doubles.

export const OPTION_STRING = 3;
export const OPTION_INTEGER = 4;

// The 18 types, in the order data/builder/app-data.json lists them. Only the
// labels on the picker: the multipliers are always read from the site's chart.
// tests/run-discord-bot.mjs fails if this list drifts from app-data.json.
export const TYPE_NAMES = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground',
  'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy'
];

const formatOption = {
  type: OPTION_STRING,
  name: 'format',
  description: 'Doubles (default) or Singles',
  required: false,
  choices: [
    { name: 'Doubles', value: 'Doubles' },
    { name: 'Singles', value: 'Singles' }
  ]
};

const pokemonOption = (description = 'Pokemon name, for example Garchomp') => ({
  type: OPTION_STRING,
  name: 'pokemon',
  description,
  required: true,
  autocomplete: true
});

const moveOption = {
  type: OPTION_STRING,
  name: 'move',
  description: 'Optional: one move to look at in detail',
  required: false,
  autocomplete: true
};

const itemOption = {
  type: OPTION_STRING,
  name: 'item',
  description: 'Optional: one item to look at in detail',
  required: false,
  autocomplete: true
};

/** Which name list an autocompleting option is completed from. */
export const AUTOCOMPLETE_KINDS = {
  pokemon: 'pokemon',
  first: 'pokemon',
  second: 'pokemon',
  move: 'move',
  item: 'item'
};

const typeChoices = TYPE_NAMES.map((name) => ({ name, value: name }));

export const COMMANDS = [
  {
    name: 'pokemon',
    description: 'Usage, typing, base stats and the most common set for one Pokemon',
    options: [pokemonOption(), formatOption]
  },
  {
    name: 'moves',
    description: 'The most used moves on one Pokemon',
    options: [pokemonOption(), moveOption, formatOption]
  },
  {
    name: 'items',
    description: 'The most used held items on one Pokemon',
    options: [pokemonOption(), itemOption, formatOption]
  },
  {
    name: 'teammates',
    description: 'The Pokemon that most often share a team with this one',
    options: [pokemonOption(), formatOption]
  },
  {
    name: 'meta',
    description: 'The current usage ranking',
    options: [
      formatOption,
      {
        type: OPTION_INTEGER,
        name: 'top',
        description: 'How many places to show (5-25, default 10)',
        required: false,
        min_value: 5,
        max_value: 25
      }
    ]
  },
  {
    name: 'compare',
    description: 'Two Pokemon side by side: usage, typing, stats and shared teammates',
    options: [
      { ...pokemonOption('First Pokemon'), name: 'first' },
      { ...pokemonOption('Second Pokemon'), name: 'second' },
      formatOption
    ]
  },
  {
    name: 'speed',
    description: 'What this Pokemon outspeeds on its most used spread',
    options: [pokemonOption(), formatOption]
  },
  {
    name: 'matchup',
    description: 'What a typing resists, takes double from and hits hard',
    options: [
      { type: OPTION_STRING, name: 'type', description: 'The type, or the first of two', required: true, choices: typeChoices },
      { type: OPTION_STRING, name: 'second_type', description: 'Second type, for a dual-typed Pokemon', required: false, choices: typeChoices }
    ]
  },
  {
    name: 'counters',
    description: 'Meta Pokemon whose usual moves hit this one super effectively',
    options: [pokemonOption(), formatOption]
  },
  {
    name: 'help',
    description: 'What this bot can answer, and where the data comes from',
    options: []
  }
];

export const COMMAND_NAMES = COMMANDS.map((command) => command.name);

/** Commands answered straight away; everything else defers first (see interactions.js). */
export const IMMEDIATE_COMMANDS = new Set(['help']);

/** Read one option out of an interaction's option list. */
export function optionValue(options, name, fallback = null) {
  const found = (options || []).find((option) => option.name === name);
  return found && found.value !== undefined && found.value !== '' ? found.value : fallback;
}

/** The option Discord is asking autocomplete for, if any. */
export function focusedOption(options) {
  return (options || []).find((option) => option.focused) || null;
}
