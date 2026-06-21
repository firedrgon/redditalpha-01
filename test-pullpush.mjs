async function test() {
  const res = await fetch(
    "https://api.pullpush.io/reddit/search/submission/?subreddit=wallstreetbets&q=NVDA&size=100"
  );
  const data = await res.json();
  const posts = data.data || [];
  const ticker = "NVDA";
  const upperTicker = ticker.toUpperCase();

  const tickerInTitle = posts.filter((p) => {
    const title = (p.title || "").toUpperCase();
    const regex = new RegExp(`\\b${upperTicker}\\b`);
    return regex.test(title);
  });

  console.log(`\nTotal: ${posts.length}, ticker in title: ${tickerInTitle.length}`);

  const byScore = [...posts].sort(
    (a, b) => (b.score || 0) - (a.score || 0)
  );

  console.log("\n--- TOP 10 by score ---");
  byScore.slice(0, 10).forEach((p, i) => {
    console.log(
      `${i + 1}. [score:${p.score}] [comments:${p.num_comments}]`,
      (p.title || "").slice(0, 80)
    );
  });

  const topByScoreWithTicker = [...tickerInTitle].sort(
    (a, b) => (b.score || 0) - (a.score || 0)
  );

  console.log(`\n--- TOP 10 by score (ticker in title: ${tickerInTitle.length}) ---`);
  topByScoreWithTicker.slice(0, 10).forEach((p, i) => {
    console.log(
      `${i + 1}. [score:${p.score}] [comments:${p.num_comments}]`,
      (p.title || "").slice(0, 80)
    );
  });

  console.log("\n--- Score distribution ---");
  const minScore = 20;
  const hot = posts.filter(p => (p.score || 0) >= minScore).sort(
    (a, b) => (b.score || 0) - (a.score || 0)
  );
  console.log(`score >= ${minScore}: ${hot.length} posts`);
  hot.slice(0, 10).forEach((p, i) => {
    console.log(
      `${i + 1}. [score:${p.score}] [comments:${p.num_comments}]`,
      (p.title || "").slice(0, 80)
    );
  });
}

test();
