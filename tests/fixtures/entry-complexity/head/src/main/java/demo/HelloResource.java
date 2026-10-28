package demo;

import io.vertx.core.Future;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;

@Path("/hello")
public class HelloResource {
    private final Greeter greeter = new Greeter();

    @GET
    @Path("/{name}")
    public Future<String> greet(String name) {
        return greeter.greet(name);
    }
}
