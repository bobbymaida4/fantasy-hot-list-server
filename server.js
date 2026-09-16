const express = require("express");
const cors = require("cors");
const { parse } = require("csv-parse/sync");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

const CURRENT_SEASON = 2026;
const PRIOR_SEASON = 2025;
const CACHE_MS = 5 * 60 * 1000;

const URLS = {
  currentStats:
    "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.csv",
  priorStats:
    "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2025.csv",
  schedules:
    "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv",
  depthCharts:
    "https://github.com/nflverse/nflverse-data/releases/download/depth_charts/depth_charts_2026.csv",
  rosters:
    "https://github.com/nflverse/nflverse-data/releases/download/rosters/roster_2026.csv",
};

// Position baselines are intentionally ordinary, not elite-player baselines.
// Player-specific 2025 history replaces these as soon as enough history exists.
const POSITION_PRIORS = {
  QB: {
    attempts: 32.0,
    passYpa: 7.05,
    passTdRate: 0.045,
    intRate: 0.022,
    carries: 4.2,
    rushYpc: 4.5,
    rushTdRate: 0.035,
  },
  RB: {
    carries: 12.5,
    rushYpc: 4.15,
    rushTdRate: 0.033,
    targets: 3.4,
    catchRate: 0.72,
    recYpt: 6.9,
    recTdRate: 0.030,
  },
  WR: {
    carries: 0.4,
    rushYpc: 6.0,
    rushTdRate: 0.025,
    targets: 6.4,
    catchRate: 0.64,
    recYpt: 8.1,
    recTdRate: 0.045,
  },
  TE: {
    carries: 0.05,
    rushYpc: 3.0,
    rushTdRate: 0.02,
    targets: 5.0,
    catchRate: 0.68,
    recYpt: 7.5,
    recTdRate: 0.043,
  },
};

let cache = null;
let cacheTime = 0;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function safeDiv(numerator, denominator, fallback = 0) {
  return denominator > 0 ? numerator / denominator : fallback;
}

function sum(rows, field) {
  return rows.reduce((total, row) => total + num(row[field]), 0);
}

function average(rows, field) {
  return rows.length ? sum(rows, field) / rows.length : 0;
}

function recentAverage(rows, field, count = 2) {
  return average(rows.slice(-count), field);
}

function standardDeviation(rows, field) {
  if (rows.length < 2) return 0;

  const avg = average(rows, field);

  const variance =
    rows.reduce((total, row) => {
      const difference = num(row[field]) - avg;
      return total + difference * difference;
    }, 0) / rows.length;

  return Math.sqrt(variance);
}

function mean(values) {
  return values.length
    ? values.reduce((a, b) => a + b, 0) / values.length
    : 0;
}

function parseStatusOverrides() {
  // Optional hook for a future licensed injury/news feed or manual confirmed news.
  // Example:
  // PLAYER_AVAILABILITY_JSON='{"00-0034857":{"status":"QUESTIONABLE"}}'

  try {
    return JSON.parse(process.env.PLAYER_AVAILABILITY_JSON || "{}");
  } catch (error) {
    console.warn(
      "PLAYER_AVAILABILITY_JSON is invalid; ignoring overrides."
    );

    return {};
  }
}

const availabilityOverrides = parseStatusOverrides();

async function fetchCsv(url, { required = true } = {}) {
  try {
    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const text = await response.text();

    return parse(text, {
      columns: true,
      skip_empty_lines: true,
    });
  } catch (error) {
    if (required) {
      throw new Error(
        `CSV download failed (${url}): ${error.message}`
      );
    }

    console.warn(
      `Optional data unavailable (${url}): ${error.message}`
    );

    return [];
  }
}

function currentEasternKey() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = Object.fromEntries(
    formatter
      .formatToParts(new Date())
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );

  return Number(
    `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}`
  );
}

function kickoffKey(game) {
  if (!game?.gameday || !game?.gametime) return NaN;

  const date = String(game.gameday).replaceAll("-", "");

  const [hour = "00", minute = "00"] =
    String(game.gametime).split(":");

  return Number(
    `${date}${hour.padStart(2, "0")}${minute.padStart(2, "0")}`
  );
}

function upcomingGame(
  team,
  schedules,
  nowKey = currentEasternKey()
) {
  const future = schedules
    .filter((game) => {
      if (Number(game.season) !== CURRENT_SEASON) return false;

      if (game.game_type && game.game_type !== "REG") return false;

      if (
        game.home_team !== team &&
        game.away_team !== team
      ) {
        return false;
      }

      const key = kickoffKey(game);

      return Number.isFinite(key) && key > nowKey;
    })
    .sort(
      (a, b) =>
        kickoffKey(a) - kickoffKey(b)
    );

  const game = future[0];

  if (!game) {
    return {
      opponent: "TBD",
      week: null,
      totalLine: null,
      atHome: null,
    };
  }

  return {
    opponent:
      game.home_team === team
        ? game.away_team
        : game.home_team,

    week: Number(game.week),

    totalLine:
      num(game.total_line) || null,

    atHome:
      game.home_team === team,
  };
}

function groupByPlayer(rows) {
  const grouped = {};

  for (const row of rows) {
    if (!row.player_id) continue;

    if (!grouped[row.player_id]) {
      grouped[row.player_id] = [];
    }

    grouped[row.player_id].push(row);
  }

  Object.values(grouped).forEach((games) =>
    games.sort(
      (a, b) =>
        Number(a.week) - Number(b.week)
    )
  );

  return grouped;
}

function playerSpecificPrior(
  previousGames,
  field,
  positionBaseline
) {
  if (!previousGames.length) {
    return positionBaseline;
  }

  const playerAverage =
    average(previousGames, field);

  const reliability =
    clamp(previousGames.length / 8, 0, 1);

  return (
    positionBaseline * (1 - reliability) +
    playerAverage * reliability
  );
}

function projectVolume(
  currentGames,
  previousGames,
  field,
  positionBaseline
) {
  const prior = playerSpecificPrior(
    previousGames,
    field,
    positionBaseline
  );

  if (!currentGames.length) {
    return prior;
  }

  const seasonAverage =
    average(currentGames, field);

  const recent =
    recentAverage(currentGames, field, 2);

  const currentEstimate =
    currentGames.length >= 2
      ? seasonAverage * 0.75 +
        recent * 0.25
      : seasonAverage;

  // Usage can move faster than efficiency,
  // but Week 1 is still only one game.
  // 1 game: 29% current / 71% prior.
  // 2 games: 44% current / 56% prior.

  const pseudoGames =
    previousGames.length ? 2.5 : 1.8;

  const currentWeight =
    currentGames.length /
    (currentGames.length + pseudoGames);

  return (
    prior * (1 - currentWeight) +
    currentEstimate * currentWeight
  );
}

function projectedRate({
  currentGames,
  previousGames,
  numerator,
  denominator,
  baselineRate,
  priorPseudoOpps,
  currentPseudoOpps,
}) {
  const previousNumerator =
    sum(previousGames, numerator);

  const previousDenominator =
    sum(previousGames, denominator);

  // Full-season player efficiency is shrunk
  // toward a normal positional rate.

  const priorRate = safeDiv(
    previousNumerator +
      baselineRate * priorPseudoOpps,

    previousDenominator +
      priorPseudoOpps,

    baselineRate
  );

  const currentNumerator =
    sum(currentGames, numerator);
  const currentDenominator =
    sum(currentGames, denominator);

  // Current-season efficiency gets a much heavier prior than usage.
  // One hot/cold game therefore cannot become the next projection by itself.

  return safeDiv(
    priorRate * currentPseudoOpps +
      currentNumerator,

    currentPseudoOpps +
      currentDenominator,

    priorRate
  );
}

function teamGameTotals(rows) {
  const games = {};

  for (const row of rows) {
    if (row.season_type !== "REG") continue;

    const team =
      row.recent_team || row.team;

    const opponent =
      row.opponent_team;

    if (!team || !opponent) continue;

    const key =
      `${row.season}-${row.week}-${team}`;

    if (!games[key]) {
      games[key] = {
        season: Number(row.season),
        week: Number(row.week),
        team,
        opponent,
        passing: 0,
        rushing: 0,
        receiving: 0,
      };
    }

    games[key].passing +=
      num(row.passing_yards);

    games[key].rushing +=
      num(row.rushing_yards);

    games[key].receiving +=
      num(row.receiving_yards);
  }

  return Object.values(games);
}

function buildOffenseBaselines(priorStats) {
  const grouped = {};

  const games =
    teamGameTotals(priorStats);

  for (const game of games) {
    if (!grouped[game.team]) {
      grouped[game.team] = [];
    }

    grouped[game.team].push(game);
  }

  const league = {
    passing:
      mean(
        games.map(
          (game) => game.passing
        )
      ) || 225,

    rushing:
      mean(
        games.map(
          (game) => game.rushing
        )
      ) || 110,

    receiving:
      mean(
        games.map(
          (game) => game.receiving
        )
      ) || 225,
  };

  const teams = {};

  for (const [team, teamGames]
    of Object.entries(grouped)) {

    teams[team] = {
      passing:
        mean(
          teamGames.map(
            (game) => game.passing
          )
        ),

      rushing:
        mean(
          teamGames.map(
            (game) => game.rushing
          )
        ),

      receiving:
        mean(
          teamGames.map(
            (game) => game.receiving
          )
        ),
    };
  }

  return {
    teams,
    league,
  };
}

function buildRawDefenseRatios(stats) {
  const games =
    teamGameTotals(stats);

  const allowed = {};

  for (const game of games) {
    const defense =
      game.opponent;

    if (!allowed[defense]) {
      allowed[defense] = {
        games: 0,
        passing: 0,
        rushing: 0,
        receiving: 0,
      };
    }

    allowed[defense].games += 1;

    allowed[defense].passing +=
      game.passing;

    allowed[defense].rushing +=
      game.rushing;

    allowed[defense].receiving +=
      game.receiving;
  }

  const league = {
    passing:
      mean(
        games.map(
          (game) => game.passing
        )
      ) || 225,

    rushing:
      mean(
        games.map(
          (game) => game.rushing
        )
      ) || 110,

    receiving:
      mean(
        games.map(
          (game) => game.receiving
        )
      ) || 225,
  };

  const ratios = {};

  for (const [team, data]
    of Object.entries(allowed)) {

    ratios[team] = {
      games:
        data.games,

      passing:
        safeDiv(
          data.passing /
            data.games,

          league.passing,
          1
        ),

      rushing:
        safeDiv(
          data.rushing /
            data.games,

          league.rushing,
          1
        ),

      receiving:
        safeDiv(
          data.receiving /
            data.games,

          league.receiving,
          1
        ),
    };
  }

  return {
    ratios,
    league,
  };
}

function buildDefenseContext(
  currentStats,
  priorStats
) {
  const priorDefense =
    buildRawDefenseRatios(
      priorStats
    );

  const offensePrior =
    buildOffenseBaselines(
      priorStats
    );

  const currentGames =
    teamGameTotals(
      currentStats
    );

  const currentAdjusted = {};

  // Schedule-adjust current results.
  // Allowing 260 passing yards to a team
  // that normally produces 300 is different
  // from allowing 260 to a 190-yard offense.

  for (const game of currentGames) {
    const defense =
      game.opponent;

    const expected =
      offensePrior.teams[
        game.team
      ] ||
      offensePrior.league;

    if (!currentAdjusted[defense]) {
      currentAdjusted[defense] = {
        games: 0,
        passing: 0,
        rushing: 0,
        receiving: 0,
      };
    }

    currentAdjusted[
      defense
    ].games += 1;

    currentAdjusted[
      defense
    ].passing += clamp(
      safeDiv(
        game.passing,
        expected.passing,
        1
      ),
      0.5,
      1.5
    );

    currentAdjusted[
      defense
    ].rushing += clamp(
      safeDiv(
        game.rushing,
        expected.rushing,
        1
      ),
      0.5,
      1.5
    );

    currentAdjusted[
      defense
    ].receiving += clamp(
      safeDiv(
        game.receiving,
        expected.receiving,
        1
      ),
      0.5,
      1.5
    );
  }

  const teams =
    new Set([
      ...Object.keys(
        priorDefense.ratios
      ),

      ...Object.keys(
        currentAdjusted
      ),
    ]);

  const factors = {};

  for (const team of teams) {
    const prior =
      priorDefense.ratios[
        team
      ] || {
        passing: 1,
        rushing: 1,
        receiving: 1,
      };

    const current =
      currentAdjusted[
        team
      ];

    const currentGamesPlayed =
      current?.games || 0;

    // One current-season game is only
    // 20% of the defensive view.
    // Four games are 50%.

    const currentWeight =
      currentGamesPlayed /
      (
        currentGamesPlayed +
        4
      );

    const combine = (type) => {
      const currentRatio =
        current
          ? current[type] /
            current.games
          : prior[type];

      const blended =
        prior[type] *
          (1 - currentWeight) +
        currentRatio *
          currentWeight;

      // Defense affects efficiency,
      // not projected workload.
      // Early in the season we cap the
      // effect at roughly +/-6%.

      return clamp(
        1 +
          (blended - 1) *
            0.35,

        0.94,
        1.06
      );
    };

    factors[team] = {
      passing:
        combine(
          "passing"
        ),

      rushing:
        combine(
          "rushing"
        ),

      receiving:
        combine(
          "receiving"
        ),

      currentGames:
        currentGamesPlayed,
    };
  }

  return {
    factors,
  };
}

function matchupFactor(
  opponent,
  type,
  defenseContext
) {
  return (
    defenseContext
      ?.factors
      ?.[opponent]
      ?.[type] || 1
  );
}

function buildDepthMap(rows) {
  if (!rows.length) {
    return {};
  }

  const latestByTeam = {};

  for (const row of rows) {
    if (
      !row.team ||
      !row.dt
    ) {
      continue;
    }

    if (
      !latestByTeam[
        row.team
      ] ||
      row.dt >
        latestByTeam[
          row.team
        ]
    ) {
      latestByTeam[
        row.team
      ] = row.dt;
    }
  }

  const map = {};

  for (const row of rows) {
    if (
      !row.gsis_id ||
      !row.team ||
      row.dt !==
        latestByTeam[
          row.team
        ]
    ) {
      continue;
    }

    map[row.gsis_id] = {
      team:
        row.team,

      posAbb:
        row.pos_abb || "",

      posRank:
        num(
          row.pos_rank
        ) || null,

      posSlot:
        num(
          row.pos_slot
        ) || null,

      dt:
        row.dt,
    };
  }

  return map;
}

function buildRosterMap(rows) {
  const map = {};

  for (const row of rows) {
    if (!row.gsis_id) {
      continue;
    }

    map[row.gsis_id] = {
      team:
        row.team || null,

      status:
        String(
          row.status || ""
        ).toUpperCase(),

      statusDescription:
        row.status_description_abbr ||
        null,
    };
  }

  return map;
}

function availabilityInfo(
  playerId,
  playerName,
  rosterInfo
) {
  const override =
    availabilityOverrides[
      playerId
    ] ||
    availabilityOverrides[
      playerName
    ] ||
    null;

  const rawStatus =
    String(
      override?.status ||
      rosterInfo?.status ||
      "ACTIVE"
    ).toUpperCase();

  const hardOut =
    new Set([
      "OUT",
      "IR",
      "RES",
      "PUP",
      "NFI",
      "SUS",
      "SUSPENDED",
      "INA",
      "INACTIVE",
      "UFA",
      "RET",
      "DEV",
    ]);

  let factor = 1;

  if (
    hardOut.has(
      rawStatus
    )
  ) {
    factor = 0;
  } else if (
    rawStatus ===
    "DOUBTFUL"
  ) {
    factor = 0.55;
  } else if (
    rawStatus ===
    "QUESTIONABLE"
  ) {
    factor = 0.92;
  }

  return {
    status:
      rawStatus,

    factor,

    starterOverride:
      typeof override?.starter ===
      "boolean"
        ? override.starter
        : null,
  };
}

function scoringEnvironment(
  totalLine
) {
  if (!Number.isFinite(totalLine) || totalLine <= 0) return 1;

  // A game total should mainly move TD expectation,
  // not raw touches/targets.

  return clamp(
    1 + (totalLine - 44) * 0.006,
    0.95,
    1.05
  );
}

function touchdownProbability(
  expectedTouchdowns,
  min = 0.02,
  max = 0.92
) {
  const probability =
    1 -
    Math.exp(
      -Math.max(
        0,
        expectedTouchdowns
      )
    );

  return clamp(
    probability,
    min,
    max
  );
}

function calculateConfidence({
  currentGames,
  previousGames,
  primaryField,
  depthRank,
  availability,
  position,
}) {
  const currentSample =
    clamp(
      currentGames.length * 2.5,
      2,
      12
    );

  const history =
    clamp(
      previousGames.length * 0.75,
      0,
      10
    );

  let role = 3;

  if (depthRank === 1) {
    role =
      position === "QB"
        ? 9
        : 8;
  } else if (
    depthRank === 2
  ) {
    role = 5;
  } else if (
    !depthRank
  ) {
    role = 4;
  }

  let stability = 4;

  if (
    currentGames.length >= 2
  ) {
    const avg =
      average(
        currentGames,
        primaryField
      );

    const cv =
      avg > 0
        ? standardDeviation(
            currentGames,
            primaryField
          ) / avg
        : 1;

    stability =
      clamp(
        10 - cv * 9,
        1,
        10
      );
  }

  let availabilityPenalty = 0;

  if (
    availability.factor === 0
  ) {
    availabilityPenalty = 30;
  } else if (
    availability.factor < 0.7
  ) {
    availabilityPenalty = 12;
  } else if (
    availability.factor < 1
  ) {
    availabilityPenalty = 5;
  }

  const confidence =
    50 +
    currentSample +
    history +
    role +
    stability -
    availabilityPenalty;

  return Math.round(
    clamp(
      confidence,
      50,
      90
    )
  );
}

function buildProjection({
  currentGames,
  previousGames,
  schedules,
  defenseContext,
  depthMap,
  rosterMap,
}) {
  const latest =
    currentGames[
      currentGames.length - 1
    ];

  const position =
    latest.position;

  const playerId =
    latest.player_id;

  const player =
    latest.player_display_name ||
    latest.player_name ||
    "Unknown Player";

  const rosterInfo =
    rosterMap[playerId];

  const depthInfo =
    depthMap[playerId];

  const team =
    rosterInfo
      ? rosterInfo.team || "FA"
      : latest.recent_team ||
        latest.team ||
        "FA";

  const matchup =
    upcomingGame(
      team,
      schedules
    );

  const availability =
    availabilityInfo(
      playerId,
      player,
      rosterInfo
    );

  const env =
    scoringEnvironment(
      matchup.totalLine
    );

  const passMatchup =
    matchupFactor(
      matchup.opponent,
      "passing",
      defenseContext
    );

  const rushMatchup =
    matchupFactor(
      matchup.opponent,
      "rushing",
      defenseContext
    );

  const receiveMatchup =
    matchupFactor(
      matchup.opponent,
      "receiving",
      defenseContext
    );

  let passingAttempts = 0;
  let passingYards = 0;
  let passingTDs = 0;
  let passingInterceptions = 0;
  let rushingYards = 0;
  let rushingTDs = 0;
  let receivingYards = 0;
  let receivingTDs = 0;
  let receptions = 0;
  let targets = 0;
  let carries = 0;
  let fantasyPoints = 0;
  let expectedTouchdowns = 0;
  let tdProbability = 0;
  let tdProbabilityType =
    "ANY_TD";
  let market = "";
  let clue = "";
  let primaryField = "";

  const prior =
    POSITION_PRIORS[position];

  if (!prior) {
    return null;
  }

  if (position === "QB") {
    passingAttempts =
      clamp(
        projectVolume(
          currentGames,
          previousGames,
          "attempts",
          prior.attempts
        ),
        15,
        45
      );

    const ypa =
      projectedRate({
        currentGames,
        previousGames,
        numerator:
          "passing_yards",
        denominator:
          "attempts",
        baselineRate:
          prior.passYpa,
        priorPseudoOpps:
          120,
        currentPseudoOpps:
          120,
      });

    const passTdRate =
      projectedRate({
        currentGames,
        previousGames,
        numerator:
          "passing_tds",
        denominator:
          "attempts",
        baselineRate:
          prior.passTdRate,
        priorPseudoOpps:
          180,
        currentPseudoOpps:
          180,
      });

    const intRate =
      projectedRate({
        currentGames,
        previousGames,
        numerator:
          "passing_interceptions",
        denominator:
          "attempts",
        baselineRate:
          prior.intRate,
        priorPseudoOpps:
          220,
        currentPseudoOpps:
          200,
      });

    carries =
      clamp(
        projectVolume(
          currentGames,
          previousGames,
          "carries",
          prior.carries
        ),
        0,
        13
      );

    const rushYpc =
      projectedRate({
        currentGames,
        previousGames,
        numerator:
          "rushing_yards",
        denominator:
          "carries",
        baselineRate:
          prior.rushYpc,
        priorPseudoOpps:
          35,
        currentPseudoOpps:
          35,
      });

    const rushTdRate =
      projectedRate({
        currentGames,
        previousGames,
        numerator:
          "rushing_tds",
        denominator:
          "carries",
        baselineRate:
          prior.rushTdRate,
        priorPseudoOpps:
          90,
        currentPseudoOpps:
          80,
      });

    // Matchup modifies efficiency only.
    // It does NOT multiply pass attempts/carries.

    passingYards =
      clamp(
        passingAttempts *
          ypa *
          passMatchup,
        100,
        350
      );

    passingTDs =
      clamp(
        passingAttempts *
          passTdRate *
          env *
          (
            1 +
            (passMatchup - 1) *
              0.7
          ),
        0.3,
        3.2
      );

    passingInterceptions =
      clamp(
        passingAttempts *
          intRate,
        0,
        2.2
      );

    rushingYards =
      clamp(
        carries *
          rushYpc *
          (
            1 +
            (rushMatchup - 1) *
              0.5
          ),
        0,
        90
      );

    rushingTDs =
      clamp(
        carries *
          rushTdRate *
          env,
        0,
        1.2
      );

    expectedTouchdowns =
      passingTDs +
      rushingTDs;

    // For QBs the TD percentage is
    // the chance of at least one PASS TD.

    tdProbability =
      touchdownProbability(
        passingTDs,
        0.15,
        0.94
      );

    tdProbabilityType =
      "PASS_TD";

    fantasyPoints =
      passingYards * 0.04 +
      passingTDs * 4 -
      passingInterceptions * 2 +
      rushingYards * 0.1 +
      rushingTDs * 6;

    market =
      `Projected ${Math.round(
        passingYards
      )} passing yards`;

    clue =
      `${passingAttempts.toFixed(
        1
      )} projected pass attempts, ` +
      `${Math.round(
        passingYards
      )} passing yards, ` +
      `${passingTDs.toFixed(
        1
      )} pass TD and ` +
      `${Math.round(
        rushingYards
      )} rushing yards. ` +
      `Matchup changes efficiency, not workload.`;

    primaryField =
      "passing_yards";
  } else {
    carries =
      clamp(
        projectVolume(
          currentGames,
          previousGames,
          "carries",
          prior.carries
        ),
        0,
        position === "RB"
          ? 28
          : 5
      );

    targets =
      clamp(
        projectVolume(
          currentGames,
          previousGames,
          "targets",
          prior.targets
        ),
        0,
        position === "RB"
          ? 11
          : 15
      );

    const rushYpc =
      projectedRate({
        currentGames,
        previousGames,
        numerator:
          "rushing_yards",
        denominator:
          "carries",
        baselineRate:
          prior.rushYpc,
        priorPseudoOpps:
          45,
        currentPseudoOpps:
          45,
      });

    const rushTdRate =
      projectedRate({
        currentGames,
        previousGames,
        numerator:
          "rushing_tds",
        denominator:
          "carries",
        baselineRate:
          prior.rushTdRate,
        priorPseudoOpps:
          110,
        currentPseudoOpps:
          100,
      });

    const catchRate =
      projectedRate({
        currentGames,
        previousGames,
        numerator:
          "receptions",
        denominator:
          "targets",
        baselineRate:
          prior.catchRate,
        priorPseudoOpps:
          55,
        currentPseudoOpps:
          55,
      });

    const recYpt =
      projectedRate({
        currentGames,
        previousGames,
        numerator:
          "receiving_yards",
        denominator:
          "targets",
        baselineRate:
          prior.recYpt,
        priorPseudoOpps:
          60,
        currentPseudoOpps:
          60,
      });

    const recTdRate =
      projectedRate({
        currentGames,
        previousGames,
        numerator:
          "receiving_tds",
        denominator:
          "targets",
        baselineRate:
          prior.recTdRate,
        priorPseudoOpps:
          120,
        currentPseudoOpps:
          110,
      });

    rushingYards =
      clamp(
        carries *
          rushYpc *
          rushMatchup,
        0,
        position === "RB"
          ? 145
          : 60
      );

    rushingTDs =
      clamp(
        carries *
          rushTdRate *
          env,
        0,
        1.4
      );

    receptions =
      clamp(
        targets *
          catchRate,
        0,
        12
      );

    receivingYards =
      clamp(
        targets *
          recYpt *
          receiveMatchup,
        0,
        position === "WR"
          ? 150
          : position === "TE"
          ? 120
          : 95
      );

    receivingTDs =
      clamp(
        targets *
          recTdRate *
          env,
        0,
        1.4
      );

    expectedTouchdowns =
      rushingTDs +
      receivingTDs;

    tdProbability =
      touchdownProbability(
        expectedTouchdowns,
        0.02,
        0.9
      );

    fantasyPoints =
      rushingYards * 0.1 +
      receivingYards * 0.1 +
      receptions +
      expectedTouchdowns * 6;

    if (position === "RB") {
      market =
        `Projected ${Math.round(
          rushingYards
        )} rushing yards`;

      clue =
        `${carries.toFixed(
          1
        )} carries, ` +
        `${targets.toFixed(
          1
        )} targets and ` +
        `${Math.round(
          tdProbability * 100
        )}% personal TD probability.`;

      primaryField =
        "rushing_yards";
    } else {
      market =
        `Projected ${Math.round(
          receivingYards
        )} receiving yards`;

      clue =
        `${targets.toFixed(
          1
        )} targets, ` +
        `${receptions.toFixed(
          1
        )} receptions and ` +
        `${Math.round(
          tdProbability * 100
        )}% personal TD probability.`;

      primaryField =
        "receiving_yards";
    }
  }
const confidence =
    calculateConfidence({
      currentGames,
      previousGames,
      primaryField,
      depthRank:
        depthInfo?.posRank ||
        null,
      availability,
      position,
    });

  const depthRank =
    depthInfo?.posRank ||
    null;

  let starter = true;

  if (
    availability.starterOverride !== null
  ) {
    starter =
      availability.starterOverride;
  } else if (
    position === "QB" &&
    depthRank &&
    depthRank !== 1
  ) {
    starter = false;
  }

  return {
    playerId,
    player,
    position,
    team,
    opponent:
      matchup.opponent,
    week:
      matchup.week,
    atHome:
      matchup.atHome,

    status:
      availability.status,

    starter,

    depthRank,

    passingAttempts:
      Number(
        passingAttempts.toFixed(1)
      ),

    passingYards:
      Math.round(
        passingYards
      ),

    passingTDs:
      Number(
        passingTDs.toFixed(2)
      ),

    passingInterceptions:
      Number(
        passingInterceptions.toFixed(2)
      ),

    carries:
      Number(
        carries.toFixed(1)
      ),

    rushingYards:
      Math.round(
        rushingYards
      ),

    rushingTDs:
      Number(
        rushingTDs.toFixed(2)
      ),

    targets:
      Number(
        targets.toFixed(1)
      ),

    receptions:
      Number(
        receptions.toFixed(1)
      ),

    receivingYards:
      Math.round(
        receivingYards
      ),

    receivingTDs:
      Number(
        receivingTDs.toFixed(2)
      ),

    fantasyPoints:
      Number(
        (
          fantasyPoints *
          availability.factor
        ).toFixed(1)
      ),

    expectedTouchdowns:
      Number(
        expectedTouchdowns.toFixed(2)
      ),

    tdProbability:
      Math.round(
        tdProbability *
          availability.factor *
          100
      ),

    tdProbabilityType,

    confidence,

    market,
    clue,

    matchupFactors: {
      passing:
        Number(
          passMatchup.toFixed(3)
        ),

      rushing:
        Number(
          rushMatchup.toFixed(3)
        ),

      receiving:
        Number(
          receiveMatchup.toFixed(3)
        ),
    },
  };
}

function percentileRank(
  value,
  values
) {
  if (!values.length) {
    return 0.5;
  }

  const sorted =
    [...values].sort(
      (a, b) => a - b
    );

  const lowerCount =
    sorted.filter(
      (item) => item < value
    ).length;

  const equalCount =
    sorted.filter(
      (item) => item === value
    ).length;

  return (
    lowerCount +
    equalCount * 0.5
  ) / sorted.length;
}

function addHotScores(
  projections
) {
  const byPosition = {};

  const positionFantasyBaseline = {
    QB: 17.5,
    RB: 14,
    WR: 13,
    TE: 11.5,
  };

  const adjustedFantasyValues =
    projections.map(
      (player) =>
        player.fantasyPoints /
        (
          positionFantasyBaseline[
            player.position
          ] || 1
        )
    );

  for (const player of projections) {
    if (!byPosition[player.position]) {
      byPosition[player.position] = [];
    }

    byPosition[player.position].push(player);
  }

  for (const [position, players]
    of Object.entries(byPosition)) {

    const fantasyValues =
      players.map(
        (player) =>
          player.fantasyPoints
      );

    const opportunityValues =
      players.map(
        (player) => {
          if (position === "QB") {
            return (
              player.passingAttempts +
              player.carries * 0.8
            );
          }

          return (
            player.carries +
            player.targets * 1.2
          );
        }
      );

    for (const player of players) {
      const fantasyPercentile =
        percentileRank(
          player.fantasyPoints,
          fantasyValues
        );

      const adjustedFantasyValue =
        player.fantasyPoints /
        (
          positionFantasyBaseline[
            player.position
          ] || 1
        );

      const adjustedFantasyPercentile =
        percentileRank(
          adjustedFantasyValue,
          adjustedFantasyValues
        );

      const opportunity =
        position === "QB"
          ? player.passingAttempts +
            player.carries * 0.8
          : player.carries +
            player.targets * 1.2;

      const opportunityPercentile =
        percentileRank(
          opportunity,
          opportunityValues
        );

      const confidenceScore =
        clamp(
          (player.confidence - 50) / 40,
          0,
          1
        );

      const matchupAverage =
        mean(
          Object.values(
            player.matchupFactors
          )
        );

      const matchupScore =
        clamp(
          (matchupAverage - 0.94) / 0.12,
          0,
          1
        );

      const score =
        adjustedFantasyPercentile * 45 +
        fantasyPercentile * 25 +
        opportunityPercentile * 12 +
        confidenceScore * 13 +
        matchupScore * 5;

      player.hotScore =
        Math.round(
          clamp(
            score,
            0,
            100
          )
        );
    }
  }

  return projections;
}

function removeBackupQbs(
  projections
) {
  const bestQbByTeam =
    new Map();

  for (const player
    of projections) {
    if (
      player.position !==
      "QB"
    ) {
      continue;
    }

    if (
      !player.starter ||
      player.status ===
        "OUT" ||
      player.status ===
        "IR"
    ) {
      continue;
    }

    const existing =
      bestQbByTeam.get(
        player.team
      );

    if (
      !existing ||
      player.hotScore >
        existing.hotScore
    ) {
      bestQbByTeam.set(
        player.team,
        player
      );
    }
  }

  return projections.filter(
    (player) => {
      if (
        player.position !==
        "QB"
      ) {
        return true;
      }

      return (
        bestQbByTeam.get(
          player.team
        )?.playerId ===
        player.playerId
      );
    }
  );
}

function eligiblePlayer(
  projection
) {
  if (!projection) {
    return false;
  }

  if (
    ![
      "QB",
      "RB",
      "WR",
      "TE",
    ].includes(
      projection.position
    )
  ) {
    return false;
  }

  if (
    projection.team ===
      "FA" ||
    projection.opponent ===
      "TBD"
  ) {
    return false;
  }

  if (
    projection.status ===
      "OUT" ||
    projection.status ===
      "IR"
  ) {
    return false;
  }

  if (
    projection.position ===
      "QB" &&
    !projection.starter
  ) {
    return false;
  }

  return (
    projection.fantasyPoints >
    0
  );
}

async function buildModel() {
  const now =
    Date.now();

  if (
    cache &&
    now - cacheTime <
      CACHE_MS
  ) {
    return cache;
  }

  const [
    currentStats,
    priorStats,
    schedules,
    depthRows,
    rosterRows,
  ] =
    await Promise.all([
      fetchCsv(
        URLS.currentStats
      ),

      fetchCsv(
        URLS.priorStats
      ),

      fetchCsv(
        URLS.schedules
      ),

      fetchCsv(
        URLS.depthCharts,
        {
          required: false,
        }
      ),

      fetchCsv(
        URLS.rosters,
        {
          required: false,
        }
      ),
    ]);

  const currentRegular =
    currentStats.filter(
      (row) =>
        row.season_type ===
        "REG"
    );

  const priorRegular =
    priorStats.filter(
      (row) =>
        row.season_type ===
        "REG"
    );

  const currentByPlayer =
    groupByPlayer(
      currentRegular
    );

  const priorByPlayer =
    groupByPlayer(
      priorRegular
    );

  const defenseContext =
    buildDefenseContext(
      currentRegular,
      priorRegular
    );

  const depthMap =
    buildDepthMap(
      depthRows
    );

  const rosterMap =
    buildRosterMap(
      rosterRows
    );

  const projections = [];

  for (const [
    playerId,
    currentGames,
  ] of Object.entries(
    currentByPlayer
  )) {
    const projection =
      buildProjection({
        currentGames,
        previousGames:
          priorByPlayer[
            playerId
          ] || [],
        schedules,
        defenseContext,
        depthMap,
        rosterMap,
      });

    if (
      eligiblePlayer(
        projection
      )
    ) {
      projections.push(
        projection
      );
    }
  }

  addHotScores(
    projections
  );

  const filtered =
    removeBackupQbs(
      projections
    );

  filtered.sort(
    (a, b) => {
      if (
        b.hotScore !==
        a.hotScore
      ) {
        return (
          b.hotScore -
          a.hotScore
        );
      }

      if (
        b.fantasyPoints !==
        a.fantasyPoints
      ) {
        return (
          b.fantasyPoints -
          a.fantasyPoints
        );
      }

      return (
        b.confidence -
        a.confidence
      );
    }
  );

  cache = {
    season:
      CURRENT_SEASON,

    generatedAt:
      new Date().toISOString(),

    count:
      filtered.length,

    players:
      filtered,
  };

  cacheTime =
    now;

  return cache;
}

app.get(
  "/",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "Fantasy Hot List Projection API",
      season:
        CURRENT_SEASON,
    });
  }
);

app.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      season:
        CURRENT_SEASON,
      cached:
        Boolean(cache),
      generatedAt:
        cache?.generatedAt ||
        null,
    });
  }
);

app.get(
  "/api/hot-list",
  async (
    req,
    res
  ) => {
    try {
      const model =
        await buildModel();

      const limit =
        clamp(
          Number(
            req.query.limit ||
              20
          ),
          1,
          100
        );

      res.json({
        season:
          model.season,
        generatedAt:
          model.generatedAt,
        count:
          Math.min(
            limit,
            model.players.length
          ),
        players:
          model.players.slice(
            0,
            limit
          ),
      });
    } catch (error) {
      console.error(
        "Hot List error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to build Hot List",
        detail:
          error.message,
      });
    }
  }
);

app.get(
  "/api/player/:id",
  async (
    req,
    res
  ) => {
    try {
      const model =
        await buildModel();

      const player =
        model.players.find(
          (item) =>
            item.playerId ===
              req.params.id ||
            item.player
              .toLowerCase() ===
              String(
                req.params.id
              ).toLowerCase()
        );

      if (!player) {
        return res
          .status(404)
          .json({
            error:
              "Player not found",
          });
      }

      res.json(
        player
      );
    } catch (error) {
      console.error(
        "Player lookup error:",
        error
      );

      res.status(500).json({
        error:
          "Unable to load player",
        detail:
          error.message,
      });
    }
  }
);

app.post(
  "/api/cache/refresh",
  async (
    req,
    res
  ) => {
    try {
      cache = null;
      cacheTime = 0;

      const model =
        await buildModel();

      res.json({
        ok: true,
        generatedAt:
          model.generatedAt,
        count:
          model.players.length,
      });
    } catch (error) {
      res.status(500).json({
        error:
          "Refresh failed",
        detail:
          error.message,
      });
    }
  }
);

app.listen(
  PORT,
  () => {
    console.log(
      `Fantasy Hot List server running on port ${PORT}`
    );
  }
);
