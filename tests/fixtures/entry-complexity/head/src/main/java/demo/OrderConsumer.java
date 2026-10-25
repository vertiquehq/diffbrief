package demo;

import io.vertx.core.Future;
import dev.vertique.kafka.KafkaSource;

public class OrderConsumer {
    @KafkaSource(topic = "orders.created", groupId = "demo")
    public Future<Void> onOrder(String payload) {
        return Future.succeededFuture();
    }
}
