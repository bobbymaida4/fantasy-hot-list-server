const express = require("express");
const cors = require("cors");
const { parse } = require("csv-parse/sync");

const app = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const PLAYER_STATS_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2026.csv";

const SCHEDULE_URL =
  "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv";

let cache = null;
let cacheTime = 0;

const CACHE_MS = 5 * 60 * 1000;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function average(games, field) {
  if (!games.length) return 0;

  return (
    games.reduce((sum, game) => sum + num(game[field]), 0) /
    games.length
  );
}

function recentAverage(games, field, count = 3) {
  const recent = games.slice(-count);

  if (!recent.length) return 0;

  return average(recent, field);
}

function blendedProjection(games, field) {
  const season = average(games, field);
  const recent = recentAverage(games, field, 3);

  return season * 0.55 + recent * 0.45;
}

function standardDeviation(games, field) {
  if (games.length < 2) return 0;

  const values = games.map((game) => num(game[field]));
  const avg =
    values.reduce((sum, value) => sum + value, 0) /
    values.length;

  const variance =
    values.reduce(
      (sum, value) => sum + Math.pow(value - avg, 2),
      0
    ) / values.length;

  return Math.sqrt(variance);
}

function upcomingOpponent(team, schedules) {
  const now = new Date();

  const games = schedules
    .filter((game) => {
      if (Number(game.season) !== 2026) return false;

      const teamPlaying =
        game.home_team === team ||
        game.away_team === team;

      if (!teamPlaying) return false;

      const dateString =
        game.gameday ||
        game.game_date ||
        game.date;

      if (!dateString) return false;

      const date = new Date(`${dateString}T23:59:59`);

      return date >= now;
    })
    .sort((a, b) => {
      const dateA = new Date(
        a.gameday || a.game_date || a.date
      );

      const dateB = new Date(
        b.gameday || b.game_date || b.date
      );

      return dateA - dateB;
    });

  const game = games[0];

  if (!game) {
    return {
      opponent: "TBD",
      week: null,
    };
  }

  return {
    opponent:
      game.home_team === team
        ? game.away_team
        : game.home_team,

    week: Number(game.week),
  };
}

function touchdownProbability(games) {
  const rushTD = blendedProjection(
    games,
    "rushing_tds"
  );

  const receivingTD = blendedProjection(
    games,
    "receiving_tds"
  );

  const lambda = rushTD + receivingTD;

  const probability = 1 - Math.exp(-lambda);

  return clamp(probability, 0.05, 0.85);
}

function calculateConfidence(
  games,
  primaryField,
  workload
) {
  const sampleScore = clamp(
    games.length * 3,
    3,
    18
  );

  const volatility =
    standardDeviation(games, primaryField);

  const averageValue =
    average(games, primaryField);

  let consistencyScore = 8;

  if (averageValue > 0) {
    const volatilityRatio =
      volatility / averageValue;

    consistencyScore = clamp(
      14 - volatilityRatio * 10,
      2,
      14
    );
  }

  const workloadScore = clamp(
    workload * 0.5,
    2,
    12
  );

  const confidence =
    48 +
    sampleScore +
    consistencyScore +
    workloadScore;

  return Math.round(
    clamp(confidence, 55, 88)
  );
}

function buildProjection(games, schedules) {
  const latest = games[games.length - 1];

  const position = latest.position;

  const team =
    latest.recent_team ||
    latest.team ||
    "FA";

  let passingYards = blendedProjection(
    games,
    "passing_yards"
  );

  let passingTDs = blendedProjection(
    games,
    "passing_tds"
  );

  let rushingYards = blendedProjection(
    games,
    "rushing_yards"
  );

  let receivingYards = blendedProjection(
    games,
    "receiving_yards"
  );

  let receptions = blendedProjection(
    games,
    "receptions"
  );

  let targets = blendedProjection(
    games,
    "targets"
  );

  let carries = blendedProjection(
    games,
    "carries"
  );

  passingYards = clamp(
    passingYards,
    0,
    position === "QB" ? 360 : 50
  );

  rushingYards = clamp(
    rushingYards,
    0,
    position === "RB"
      ? 130
      : position === "QB"
      ? 85
      : 60
  );

  receivingYards = clamp(
    receivingYards,
    0,
    position === "WR"
      ? 125
      : position === "TE"
      ? 95
      : position === "RB"
      ? 80
      : 30
  );

  receptions = clamp(receptions, 0, 10);
  targets = clamp(targets, 0, 14);
  carries = clamp(carries, 0, 25);
  passingTDs = clamp(passingTDs, 0, 3.5);

  const tdProbability =
    touchdownProbability(games);

  let fantasyPoints = 0;
  let market = "";
  let clue = "";
  let primaryField = "";
  let workload = 0;

  if (position === "QB") {
    fantasyPoints =
      passingYards * 0.04 +
      passingTDs * 4 +
      rushingYards * 0.1;

    market =
      `Projected ${Math.round(
        passingYards
      )} passing yards`;

    clue =
      `${Math.round(
        passingYards
      )} projected passing yards using season and recent-game averages.`;

    primaryField = "passing_yards";
    workload = passingYards / 12;
  }

  if (position === "RB") {
    fantasyPoints =
      rushingYards * 0.1 +
      receivingYards * 0.1 +
      receptions +
      tdProbability * 6;

    market =
      `Projected ${Math.round(
        rushingYards
      )} rushing yards`;

    clue =
      `${carries.toFixed(
        1
      )} projected carries, ${Math.round(
        rushingYards
      )} rushing yards and ${Math.round(
        tdProbability * 100
      )}% TD probability.`;

    primaryField = "rushing_yards";
    workload = carries;
  }

  if (
    position === "WR" ||
    position === "TE"
  ) {
    fantasyPoints =
      receivingYards * 0.1 +
      receptions +
      tdProbability * 6;

    market =
      `Projected ${Math.round(
        receivingYards
      )} receiving yards`;

    clue =
      `${targets.toFixed(
        1
      )} projected targets, ${receptions.toFixed(
        1
      )} receptions and ${Math.round(
        tdProbability * 100
      )}% TD probability.`;

    primaryField = "receiving_yards";
    workload = targets;
  }

  const confidence =
    calculateConfidence(
      games,
      primaryField,
      workload
    );

  const matchup =
    upcomingOpponent(team, schedules);

  const hotScore = Math.round(
    clamp(
      confidence * 0.65 +
        fantasyPoints * 0.9,
      50,
      94
    )
  );

  return {
    id: latest.player_id,

    player:
      latest.player_display_name ||
      latest.player_name ||
      "Unknown Player",

    position,
    team,

    opponent: matchup.opponent,
    week: matchup.week,

    market,

    confidence,
    hotScore,

    clue,

    projections: {
      fantasyPoints: Number(
        fantasyPoints.toFixed(1)
      ),

      passingYards: Math.round(
        passingYards
      ),

      passingTDs: Number(
        passingTDs.toFixed(1)
      ),

      rushingYards: Math.round(
        rushingYards
      ),

      receivingYards: Math.round(
        receivingYards
      ),

      receptions: Number(
        receptions.toFixed(1)
      ),

      targets: Number(
        targets.toFixed(1)
      ),

      carries: Number(
        carries.toFixed(1)
      ),

      touchdownProbability:
        Math.round(tdProbability * 100),
    },
  };
}

async function buildHotList() {
  if (
    cache &&
    Date.now() - cacheTime < CACHE_MS
  ) {
    return cache;
  }

  console.log(
    "Downloading current NFL data..."
  );

  const [
    statsResponse,
    scheduleResponse,
  ] = await Promise.all([
    fetch(PLAYER_STATS_URL),
    fetch(SCHEDULE_URL),
  ]);

  if (!statsResponse.ok) {
    throw new Error(
      `Stats download failed: ${statsResponse.status}`
    );
  }

  if (!scheduleResponse.ok) {
    throw new Error(
      `Schedule download failed: ${scheduleResponse.status}`
    );
  }

  const statsCSV =
    await statsResponse.text();

  const scheduleCSV =
    await scheduleResponse.text();

  const stats = parse(statsCSV, {
    columns: true,
    skip_empty_lines: true,
  });

  const schedules = parse(scheduleCSV, {
    columns: true,
    skip_empty_lines: true,
  });

  const players = stats.filter(
    (row) =>
      row.season_type === "REG" &&
      ["QB", "RB", "WR", "TE"].includes(
        row.position
      )
  );

  const grouped = {};

  players.forEach((row) => {
    if (!row.player_id) return;

    if (!grouped[row.player_id]) {
      grouped[row.player_id] = [];
    }

    grouped[row.player_id].push(row);
  });

  const projections =
    Object.values(grouped)
      .map((games) => {
        games.sort(
          (a, b) =>
            Number(a.week) -
            Number(b.week)
        );

        return buildProjection(
          games,
          schedules
        );
      })
      .filter(
        (player) =>
          player.projections
            .fantasyPoints > 3
      )
      .sort(
        (a, b) =>
          b.hotScore - a.hotScore
      )
      .slice(0, 20);

  cache = {
    updatedAt:
      new Date().toISOString(),

    season: 2026,

    source:
      "nflverse",

    model:
      "Season average + recent form + workload + consistency",

    note:
      "These are statistical projections, not sportsbook odds or guaranteed outcomes.",

    picks: projections,
  };

  cacheTime = Date.now();

  return cache;
}

app.get("/", (req, res) => {
  res.json({
    status:
      "Fantasy Hot List API is running",
  });
});

app.get(
  "/api/hot-list",
  async (req, res) => {
    try {
      const data =
        await buildHotList();

      res.json(data);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          "Could not build Hot List",

        details: error.message,
      });
    }
  }
);

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Fantasy Hot List server running on port ${PORT}`
    );
  }
);