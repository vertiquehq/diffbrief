package demo;

import io.vertx.core.Future;

public class Greeter {
    public Future<String> greet(String name) {
        return Future.succeededFuture("hi " + name);
    }
}
