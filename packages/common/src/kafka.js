/**
 * Kafka client options from the environment. Locally this is a plain broker list; on Azure the same code
 * talks to Event Hubs' Kafka endpoint (KAFKA_SSL=true, SASL PLAIN with the namespace connection string).
 */
export function kafkaClientOptions(env = process.env) {
  const brokers = (env.KAFKA_BROKERS ?? '').split(',').filter(Boolean);
  const options = { brokers };
  if (env.KAFKA_SSL === 'true') options.ssl = true;
  if (env.KAFKA_SASL_USERNAME) options.sasl = { mechanism: 'plain', username: env.KAFKA_SASL_USERNAME, password: env.KAFKA_SASL_PASSWORD ?? '' };
  return options;
}
