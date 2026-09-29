import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import Home from "@/app/page";

it("renders the bootstrap page", () => {
  render(<Home />);
  expect(screen.getByRole("heading", { name: "ELISE" })).toBeInTheDocument();
});
