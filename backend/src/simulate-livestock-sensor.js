const apiUrl = process.env.SENSOR_API_URL ?? 'http://localhost:4000/api/v1';
const animalId = process.env.SENSOR_ANIMAL_ID;
const accessToken = process.env.SENSOR_ACCESS_TOKEN;
const intervalMs = 10_000;

if (!animalId || !accessToken) {
  throw new Error('Set SENSOR_ANIMAL_ID and SENSOR_ACCESS_TOKEN before starting the simulator.');
}

const endpoint = new URL(
  `livestock/${encodeURIComponent(animalId)}/telemetry`,
  apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`,
);

const randomBetween = (min, max, digits) =>
  Number((min + Math.random() * (max - min)).toFixed(digits));

while (true) {
  const reading = {
    temperature_c: randomBetween(38.2, 39.0, 1),
    activity_index: randomBetween(8, 20, 2),
    battery_level: 90,
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(reading),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Telemetry request failed (${response.status}): ${detail}`);
  }

  console.log(`${new Date().toISOString()} accepted simulated reading`, reading);
  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
