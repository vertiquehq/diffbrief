package demo;

import io.vertx.core.Future;

public class Greeter {
    public Future<String> greet(String name) {
        if (name == null || name.isBlank()) {
            if (name == null) {
                return Future.succeededFuture("hi stranger");
            }
            return Future.succeededFuture("hi");
        }
        for (int i = 0; i < name.length(); i++) {
            if (name.charAt(i) == '!') {
                return Future.succeededFuture("excited " + name);
            }
        }
        return Future.succeededFuture("hi " + name);
    }
}
